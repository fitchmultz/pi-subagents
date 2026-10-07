// Direct public ES owner, attached to one launch; no daemon or CI control channel.
#include "protected-macos-lifecycle-publication.h"
#include <EndpointSecurity/EndpointSecurity.h>
#include <spawn.h>
#include <sys/wait.h>
static int source_string(es_string_token_t value, const char *expected) {
  return value.length == strlen(expected) && !memcmp(value.data, expected, value.length);
}
static struct source_execution source_execution(const es_process_t *process) {
  return (struct source_execution){.token = process->audit_token,
                                   .parent = process->parent_audit_token,
                                   .native = {audit_token_to_pid(process->audit_token),
                                              audit_token_to_euid(process->audit_token),
                                              process->session_id, process->start_time.tv_sec,
                                              process->start_time.tv_usec}};
}
struct source_role_rule {
  const char *path, *argument, *script;
  uint32_t count;
  enum source_role role;
};
static enum source_role source_role(const es_event_exec_t *event) {
  const es_file_t *file = event->target->executable;
  if (file->path_truncated)
    return SOURCE_OTHER;
  const struct source_role_rule rules[] = {
      {"/bin/bash", HOOK_ROOT "/runner-launch.sh", NULL, 2, SOURCE_LAUNCHER},
      {LISTENER_PATH, "run", NULL, 2, SOURCE_LISTENER},
      {WORKER_PATH, "spawnclient", NULL, 4, SOURCE_WORKER},
      {"/bin/bash", "-e", HOOK_PATH, 3, SOURCE_HOOK},
      {SOURCE_BINARY, "--job-consume", NULL, 3, SOURCE_CONSUMER}};
  uint32_t count = es_exec_arg_count(event);
  for (size_t i = 0; i < sizeof(rules) / sizeof(*rules); i++) {
    const struct source_role_rule *rule = &rules[i];
    if (count == rule->count && source_string(file->path, rule->path) &&
        source_string(es_exec_arg(event, 0), rule->path) &&
        source_string(es_exec_arg(event, 1), rule->argument) &&
        (!rule->script || source_string(es_exec_arg(event, 2), rule->script)))
      return rule->role;
  }
  return SOURCE_OTHER;
}
static int source_decode(const es_message_t *message, struct source_event *event) {
  if (message->version < 4 || message->action_type != ES_ACTION_TYPE_NOTIFY)
    return 2;
  *event = (struct source_event){.global = message->global_seq_num,
                                 .sequence = message->seq_num,
                                 .time = message->mach_time,
                                 .before = source_execution(message->process)};
  switch (message->event_type) {
  case ES_EVENT_TYPE_NOTIFY_EXEC:
    event->kind = SOURCE_EXEC;
    event->role = source_role(&message->event.exec);
    event->after = source_execution(message->event.exec.target);
    return 0;
  case ES_EVENT_TYPE_NOTIFY_FORK:
    event->kind = SOURCE_FORK;
    event->after = source_execution(message->event.fork.child);
    return 0;
  case ES_EVENT_TYPE_NOTIFY_EXIT:
    event->kind = SOURCE_EXIT;
    return 0;
  default:
    return 2;
  }
}
static void source_message(const es_message_t *message) {
  pthread_mutex_lock(&source_mutex);
  int was_closed = source_state.closed, was_uncertain = source_state.uncertain;
  int had_hook = execution_present(source_state.hook);
  int had_consumer = execution_present(source_state.consumer);
  uint32_t window = atomic_load_explicit(&source_shared->window, memory_order_acquire);
  if (window != SOURCE_WINDOW_OPEN)
    source_state.closed = 1;
  struct source_event event;
  if (atomic_load_explicit(&source_shared->failed, memory_order_acquire) ||
      window > SOURCE_WINDOW_VETO || source_decode(message, &event))
    source_invalidate();
  else
    source_apply(&source_state, &event);
  if (source_state.uncertain)
    source_invalidate();
  if (source_state.closed && window == SOURCE_WINDOW_OPEN)
    atomic_store_explicit(&source_shared->window, SOURCE_WINDOW_CLOSED, memory_order_release);
  if (source_state.hook_exited || source_state.consumer_exited)
    atomic_store_explicit(&source_shared->window, SOURCE_WINDOW_CLOSED, memory_order_release);
  if ((!was_closed && source_state.closed) || (!was_uncertain && source_state.uncertain))
    source_enqueue(SOURCE_PUBLISH_CLOSED);
  else if (!had_consumer && execution_present(source_state.consumer))
    source_enqueue(SOURCE_PUBLISH_CONSUMER);
  else if (!had_hook && execution_present(source_state.hook))
    source_enqueue(SOURCE_PUBLISH_HOOK);
  pthread_mutex_unlock(&source_mutex);
}
static int source_subscribe(es_client_t **client) {
  es_new_client_result_t result;
  if (__builtin_available(macOS 27.0, *)) {
    result = es_new_descendants_client(client, ^(es_client_t *owner, const es_message_t *message) {
      (void)owner;
      source_message(message);
    });
  } else {
    return 2;
  }
  if (result != ES_NEW_CLIENT_RESULT_SUCCESS) {
    fprintf(stderr, "boundary=EndpointSecurity-client result=%d unavailable\n", result);
    return 2;
  }
  // NOTIFY only: the default path mute set can change across OS versions.
  const es_event_type_t events[] = {ES_EVENT_TYPE_NOTIFY_EXEC, ES_EVENT_TYPE_NOTIFY_FORK,
                                    ES_EVENT_TYPE_NOTIFY_EXIT};
  if (es_unmute_all_paths(*client) != ES_RETURN_SUCCESS ||
      es_unmute_all_target_paths(*client) != ES_RETURN_SUCCESS ||
      es_subscribe(*client, events, 3) != ES_RETURN_SUCCESS) {
    fputs("boundary=EndpointSecurity-subscription unavailable\n", stderr);
    return 2;
  }
  return 0;
}
static void source_child(const posix_spawnattr_t *attributes,
                         const posix_spawn_file_actions_t *actions) {
  // Revoke inherited root shared-memory/write descriptors BEFORE the UID downgrade.
  if (munmap(source_shared, sizeof(*source_shared)))
    _exit(2);
  gid_t group = 20;
  if (setgroups(1, &group) || setgid(group) || setuid(502))
    _exit(2);
  char *const args[] = {"/bin/bash", HOOK_ROOT "/runner-launch.sh", NULL};
  char *const environment[] = {"HOME=/Users/ci",
                               "USER=ci",
                               "LOGNAME=ci",
                               "SHELL=/bin/bash",
                               "TMPDIR=/tmp",
                               "LANG=C",
                               "LC_ALL=C",
                               "PATH=/bin:/usr/bin:/usr/sbin:/sbin:/Users/ci/tools/node/bin:/Users/"
                               "ci/tools/go/bin:/opt/homebrew/bin",
                               "ACTIONS_RUNNER_HOOK_JOB_STARTED=" HOOK_PATH,
                               "DOTNET_EnableDiagnostics=0",
                               NULL};
  pid_t unused;
  // SETEXEC preserves the anchored PID; CLOEXEC_DEFAULT inherits only explicit stdin/out/err.
  posix_spawn(&unused, args[0], actions, attributes, args, environment);
  _exit(2);
}
static pid_t source_launch(void) {
  posix_spawnattr_t attributes;
  posix_spawn_file_actions_t actions;
  if (posix_spawnattr_init(&attributes))
    return -1;
  if (posix_spawn_file_actions_init(&actions)) {
    posix_spawnattr_destroy(&attributes);
    return -1;
  }
  int failed =
      posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETEXEC | POSIX_SPAWN_CLOEXEC_DEFAULT);
  for (int fd = 0; fd < 3; fd++)
    failed |= posix_spawn_file_actions_addinherit_np(&actions, fd);
  pid_t child = -1;
  if (!failed) {
    pthread_mutex_lock(&source_mutex);
    child = fork();
    if (!child)
      source_child(&attributes, &actions);
    source_state.launched = child;
    pthread_mutex_unlock(&source_mutex);
  }
  failed |= posix_spawn_file_actions_destroy(&actions);
  failed |= posix_spawnattr_destroy(&attributes);
  if (failed) {
    pthread_mutex_lock(&source_mutex);
    source_invalidate();
    pthread_mutex_unlock(&source_mutex);
  }
  return child;
}
static int source_start(struct timeval boot, es_client_t **client) {
  if (!source_platform_available())
    return -1;
  if (protected_file(SOURCE_OWNER, "started\n"))
    return -1; // This immutable one-shot start stamp forbids resubscription/restart.
  int fd = regular_path(SOURCE_OWNER);
  if (fd < 0)
    return -1;
  mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
  if (task_info(mach_task_self(), TASK_AUDIT_TOKEN, (task_info_t)&source_state.owner, &count) !=
          KERN_SUCCESS ||
      count != TASK_AUDIT_TOKEN_COUNT || source_live(source_state.owner)) {
    fputs("boundary=Observer-signature-or-identity unavailable\n", stderr);
    close(fd);
    return -1;
  }
  if (source_publication_start(boot)) {
    fputs("boundary=Observer-publication unavailable\n", stderr);
    close(fd);
    return -1;
  }
  int failed = source_subscribe(client) || !access(HOOK_ROOT "/closed", F_OK);
  pthread_mutex_lock(&source_mutex);
  failed |= source_state.uncertain || atomic_load(&source_shared->failed) ||
            atomic_load(&source_shared->window) != SOURCE_WINDOW_OPEN;
  if (failed)
    source_invalidate();
  else
    atomic_store_explicit(&source_shared->ready, 1, memory_order_release);
  pthread_mutex_unlock(&source_mutex);
  if (failed) {
    if (*client)
      es_delete_client(*client);
    source_publication_stop();
    (void)protected_file(HOOK_ROOT "/closed", "source-unavailable\n");
    munmap(source_shared, sizeof(*source_shared));
    source_shared = NULL;
    close(fd);
    return -1;
  }
  return fd;
}
static int source_wait(pid_t child, int *status) {
  if (child <= 0)
    return 2;
  while (waitpid(child, status, 0) < 0) {
    if (errno != EINTR)
      return 2;
  }
  return 0;
}
static int source_finish(es_client_t *client, int failed) {
  // Child return/client deletion is NOT a drained-tail receipt.
  pthread_mutex_lock(&source_mutex);
  failed |= atomic_load(&source_shared->failed) ||
            atomic_load(&source_shared->window) > SOURCE_WINDOW_VETO;
  source_state.closed = 1;
  atomic_store_explicit(&source_shared->window, SOURCE_WINDOW_CLOSED, memory_order_release);
  atomic_store_explicit(&source_shared->ready, 0, memory_order_release);
  if (failed)
    source_invalidate();
  source_enqueue(SOURCE_PUBLISH_CLOSED);
  pthread_mutex_unlock(&source_mutex);
  failed |= es_delete_client(client) != ES_RETURN_SUCCESS;
  failed |= source_publication_stop();
  atomic_store_explicit(&source_shared->ready, 0, memory_order_release);
  failed |= msync(source_shared, sizeof(*source_shared), MS_SYNC);
  struct source_terminal terminal = {.original = source_snapshot(),
                                     .uncertain = source_state.uncertain || failed,
                                     .hook_exited = source_state.hook_exited,
                                     .consumer_exited = source_state.consumer_exited};
  failed |= protected_commit_bytes(SOURCE_TERMINAL, &terminal, sizeof(terminal),
                                   &source_shared->completed[SOURCE_RECORD_TERMINAL]);
  munmap(source_shared, sizeof(*source_shared));
  source_shared = NULL;
  return failed;
}
static int observe_job(struct timeval boot) {
  es_client_t *client = NULL;
  int fd = source_start(boot, &client);
  if (fd < 0)
    return 2;
  pid_t child = source_launch();
  int status = 0;
  int failed = source_finish(client, source_wait(child, &status));
  close(fd);
  return failed || !WIFEXITED(status) ? 2 : WEXITSTATUS(status);
}
