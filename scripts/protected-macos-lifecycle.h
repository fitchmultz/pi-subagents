// Private, bounded prospective execution state. Delivery is not a liveness barrier.
#include <bsm/libbsm.h>
#include <stdint.h>
enum source_role {
  SOURCE_OTHER,
  SOURCE_LAUNCHER,
  SOURCE_LISTENER,
  SOURCE_WORKER,
  SOURCE_HOOK,
  SOURCE_CONSUMER
};
enum source_kind { SOURCE_FORK, SOURCE_EXEC, SOURCE_EXIT };
struct source_execution {
  audit_token_t token, parent;
  struct cut native;
};
struct source_event {
  enum source_kind kind;
  enum source_role role;
  uint64_t global, sequence, time;
  struct source_execution before, after;
};
struct source_state {
  uint64_t global, sequences[3], time, anchor_global, anchor_fork_sequence;
  int seen, types[3], closed, uncertain, hook_exited, consumer_exited;
  pid_t launched;
  audit_token_t owner;
  struct source_execution launch_child, launcher, listener_child, listener, worker_child, worker,
      hook, consumer;
};
struct source_admission {
  uint32_t version;
  struct timeval boot;
  uint64_t anchor_global, anchor_fork_sequence, admitted_global, admitted_exec_sequence, mach_time;
  struct source_execution launch_child, launcher, listener, worker, hook, consumer;
};
struct source_ack {
  struct source_admission original;
  char nonce[65];
};
static int token_equal(audit_token_t a, audit_token_t b) { return !memcmp(&a, &b, sizeof(a)); }
static int token_execution_equal(audit_token_t a, audit_token_t b) {
  return audit_token_to_pid(a) == audit_token_to_pid(b) &&
         audit_token_to_pidversion(a) == audit_token_to_pidversion(b);
}
static int execution_present(struct source_execution execution) {
  return audit_token_to_pid(execution.token) > 0;
}
static int source_ack_matches(const struct source_ack *ack, audit_token_t self, struct timeval boot,
                              const char *nonce) {
  size_t length = strnlen(ack->nonce, sizeof(ack->nonce));
  if (length == sizeof(ack->nonce) || length != strlen(nonce))
    return 0;
  return ack->original.version == 1 && ack->original.boot.tv_sec == boot.tv_sec &&
         ack->original.boot.tv_usec == boot.tv_usec &&
         token_equal(self, ack->original.consumer.token) && !memcmp(nonce, ack->nonce, length);
}
static int source_fail(struct source_state *state) {
  state->closed = state->uncertain = 1;
  return 2;
}
static int source_continuity(struct source_state *state, const struct source_event *event) {
  if (event->kind > SOURCE_EXIT || event->time < state->time ||
      (state->seen && (state->global == UINT64_MAX || event->global != state->global + 1)) ||
      (state->types[event->kind] && (state->sequences[event->kind] == UINT64_MAX ||
                                     event->sequence != state->sequences[event->kind] + 1)))
    return source_fail(state);
  state->seen = state->types[event->kind] = 1;
  state->global = event->global;
  state->sequences[event->kind] = event->sequence;
  state->time = event->time;
  return 0;
}
static int source_child_fork(struct source_state *state, const struct source_event *event,
                             struct source_execution parent, struct source_execution *saved) {
  if (execution_present(*saved) || !token_equal(event->after.parent, parent.token))
    return source_fail(state);
  *saved = event->after;
  return execution_present(*saved) ? 0 : source_fail(state);
}
static int source_fork(struct source_state *state, const struct source_event *event) {
  if (audit_token_to_pid(event->after.token) == state->launched) {
    if (execution_present(state->launch_child) || !token_equal(event->before.token, state->owner) ||
        !token_equal(event->after.parent, state->owner) || event->after.native.uid != 0)
      return source_fail(state);
    state->launch_child = event->after;
    state->anchor_global = event->global;
    state->anchor_fork_sequence = event->sequence;
    return 0; // This exact new owned lifetime did not exist before this required prefix anchor.
  }
  if (execution_present(state->listener) && token_equal(event->before.token, state->listener.token))
    return source_child_fork(state, event, state->listener, &state->listener_child);
  if (execution_present(state->worker) && token_equal(event->before.token, state->worker.token))
    return source_child_fork(state, event, state->worker, &state->worker_child);
  return 0;
}
static int source_launcher_exec(struct source_state *state, const struct source_event *event) {
  const struct source_execution target = event->after;
  if (execution_present(state->launcher) || !execution_present(state->launch_child) ||
      !token_equal(target.parent, state->owner) ||
      !token_execution_equal(event->before.token, state->launch_child.token) ||
      target.native.sid != state->launch_child.native.sid ||
      target.native.seconds != state->launch_child.native.seconds ||
      target.native.microseconds != state->launch_child.native.microseconds)
    return source_fail(state);
  // setgroups/setgid/setuid alter credentials, not pidversion; only this owned downgrade uses the
  // tuple.
  state->launcher = target;
  return 0;
}
static int source_listener_exec(struct source_state *state, const struct source_event *event) {
  if (execution_present(state->listener) || !execution_present(state->launcher) ||
      !token_equal(event->before.token, state->launcher.token) ||
      !token_equal(event->after.parent, state->owner) ||
      !equal(event->after.native, state->launcher.native))
    return source_fail(state);
  state->listener = event->after;
  return 0;
}
static int source_worker_exec(struct source_state *state, const struct source_event *event) {
  if (event->role != SOURCE_WORKER || execution_present(state->worker) ||
      !execution_present(state->listener_child) ||
      !token_equal(event->before.token, state->listener_child.token) ||
      !equal(event->after.native, state->listener_child.native))
    return source_fail(state);
  state->worker = event->after;
  return 0;
}
static int source_hook_exec(struct source_state *state, const struct source_event *event) {
  if (execution_present(state->hook)) {
    if (event->role != SOURCE_CONSUMER || execution_present(state->consumer) ||
        !token_equal(event->before.token, state->hook.token) ||
        !equal(event->after.native, state->hook.native))
      return source_fail(state);
    state->consumer = event->after;
    return 0;
  }
  if (event->role != SOURCE_HOOK || !execution_present(state->worker_child) ||
      !token_equal(event->before.token, state->worker_child.token) ||
      !equal(event->after.native, state->worker_child.native))
    return source_fail(state);
  state->hook = event->after;
  return 0;
}
static int source_exec(struct source_state *state, const struct source_event *event) {
  const struct source_execution target = event->after;
  pid_t pid = audit_token_to_pid(target.token);
  if (pid == state->launched) {
    if (target.native.uid != 502)
      return source_fail(state);
    if (event->role == SOURCE_LAUNCHER)
      return source_launcher_exec(state, event);
    if (event->role == SOURCE_LISTENER)
      return source_listener_exec(state, event);
    return source_fail(state);
  }
  if (execution_present(state->listener) && token_equal(target.parent, state->listener.token))
    return source_worker_exec(state, event);
  if (execution_present(state->worker) && token_equal(target.parent, state->worker.token))
    return source_hook_exec(state, event);
  if (execution_present(state->hook) && pid == audit_token_to_pid(state->hook.token))
    return source_fail(state);
  if (execution_present(state->worker) && pid == audit_token_to_pid(state->worker.token))
    return source_fail(state);
  return 0;
}
static void source_exit(struct source_state *state, const struct source_event *event) {
  if (execution_present(state->hook) && token_equal(event->before.token, state->hook.token)) {
    state->hook_exited = 1;
    state->closed = 1;
  }
  if (execution_present(state->consumer) &&
      token_equal(event->before.token, state->consumer.token)) {
    state->consumer_exited = 1;
    state->closed = 1;
  }
  if (token_equal(event->before.token, state->worker.token) ||
      token_equal(event->before.token, state->listener.token))
    state->closed = 1;
}
static int source_apply(struct source_state *state, const struct source_event *event) {
  if (source_continuity(state, event))
    return 2;
  if (event->kind == SOURCE_EXIT)
    source_exit(state, event);
  if (state->closed)
    return state->uncertain ? 2 : 1;
  if (event->kind == SOURCE_FORK)
    return source_fork(state, event);
  return event->kind == SOURCE_EXEC ? source_exec(state, event) : 0;
}
