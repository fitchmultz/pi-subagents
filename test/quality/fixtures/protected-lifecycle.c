// LOCAL synthetic state/ACK checks only. No ES client, delivery, guest or entitlement proof.
#include <assert.h>
#include <stdio.h>
#include <string.h>
#define main protected_observer_entry
#include "../../../scripts/protected-macos-quiescence.c"
#undef main
static struct source_execution execution(int pid, int version, int parent, int parent_version) {
  // Synthetic encoding, not a kernel receipt or a production token parser.
  return (struct source_execution){
      .token = {.val = {0, 502, 20, 502, 20, pid, 42, version}},
      .parent = {.val = {0, 502, 20, 502, 20, parent, 42, parent_version}},
      .native = {pid, 502, 10, 1000 + pid, 7}};
}
static void initialize(struct source_state *state, struct source_event events[8]) {
  memset(state, 0, sizeof(*state));
  state->launched = 11;
  struct source_execution owner = execution(10, 1, 1, 1);
  owner.token.val[1] = owner.token.val[3] = 0;
  state->owner = owner.token;
  struct source_execution child = execution(11, 1, 10, 1);
  child.token.val[1] = child.token.val[3] = 0;
  child.parent = owner.token;
  child.native.uid = 0;
  struct source_execution launcher = execution(11, 2, 10, 1);
  launcher.parent = owner.token;
  struct source_execution listener = launcher;
  listener.token.val[7] = 3;
  struct source_execution worker_child = execution(12, 1, 11, 3);
  struct source_execution worker = execution(12, 2, 11, 3);
  struct source_execution hook_child = execution(13, 1, 12, 2);
  struct source_execution hook = execution(13, 2, 12, 2);
  struct source_execution consumer = execution(13, 3, 12, 2);
  events[0] = (struct source_event){SOURCE_FORK, SOURCE_OTHER, 71, 19, 100, owner, child};
  events[1] = (struct source_event){SOURCE_EXEC, SOURCE_LAUNCHER,         72,      27,
                                    101,         execution(11, 1, 10, 1), launcher};
  events[2] = (struct source_event){SOURCE_EXEC, SOURCE_LISTENER, 73, 28, 102, launcher, listener};
  events[3] = (struct source_event){SOURCE_FORK, SOURCE_OTHER, 74, 20, 103, listener, worker_child};
  events[4] = (struct source_event){SOURCE_EXEC, SOURCE_WORKER, 75, 29, 104, worker_child, worker};
  events[5] = (struct source_event){SOURCE_FORK, SOURCE_OTHER, 76, 21, 105, worker, hook_child};
  events[6] = (struct source_event){SOURCE_EXEC, SOURCE_HOOK, 77, 30, 106, hook_child, hook};
  events[7] = (struct source_event){SOURCE_EXEC, SOURCE_CONSUMER, 78, 31, 107, hook, consumer};
}
static void prefix(struct source_state *state, struct source_event *events, int count) {
  for (int i = 0; i < count; i++)
    assert(source_apply(state, &events[i]) == 0);
}
static void original_and_ack(void) {
  struct source_state state;
  struct source_event events[8];
  initialize(&state, events);
  prefix(&state, events, 8);
  assert(!state.closed && audit_token_to_pid(state.hook.token) == 13);
  assert(audit_token_to_pidversion(state.hook.token) == 2);
  assert(audit_token_to_pidversion(state.consumer.token) == 3);
  struct timeval boot = {500, 9};
  struct source_ack ack = {.original = {.version = 1, .boot = boot, .consumer = state.consumer},
                           .nonce = "nonce-fixture"};
  assert(source_ack_matches(&ack, events[7].after.token, boot, "nonce-fixture"));
  struct source_execution later = execution(13, 4, 12, 2);
  assert(!source_ack_matches(&ack, later.token, boot, "nonce-fixture"));
  assert(!source_ack_matches(&ack, state.hook.token, boot, "nonce-fixture"));
  assert(
      !source_ack_matches(&ack, state.consumer.token, (struct timeval){501, 9}, "nonce-fixture"));
  assert(!source_ack_matches(&ack, state.consumer.token, boot, "other"));
  memset(ack.nonce, 'x', sizeof(ack.nonce));
  assert(!source_ack_matches(&ack, state.consumer.token, boot, "nonce-fixture"));
  struct source_event exit = {SOURCE_EXIT, SOURCE_OTHER, 79, 8, 108, state.consumer, {0}};
  assert(source_apply(&state, &exit) == 1);
  assert(state.closed && state.consumer_exited);
  events[7].global = 80;
  events[7].sequence = 32;
  events[7].time = 109;
  events[7].after = later;
  assert(source_apply(&state, &events[7]) == 1);
  assert(audit_token_to_pidversion(state.consumer.token) == 3);
}
static void refuse_contradictions(void) {
  for (int scenario = 0; scenario < 8; scenario++) {
    struct source_state state;
    struct source_event events[8];
    initialize(&state, events);
    int before = 7;
    if (scenario == 0) {
      before = 0;
      events[0] = events[1]; // Missing owned fork anchor.
    } else if (scenario == 1) {
      before = 2;
      events[2].before.token.val[7] = 99;
    } else if (scenario == 2) {
      events[7].global = 79;
    } else if (scenario == 3) {
      events[7].sequence = 33;
    } else if (scenario == 4) {
      events[7].after.parent.val[7] = 9;
    } else if (scenario == 5) {
      events[7].time = 99;
    } else if (scenario == 6) {
      before = 6;
      events[6].role = SOURCE_OTHER;
    } else {
      before = 6;
      events[6].before.token.val[7] = 99;
    }
    prefix(&state, events, before);
    assert(source_apply(&state, &events[before]) == 2);
    assert(state.closed && state.uncertain && !execution_present(state.consumer));
  }
}
static void hook_exit(void) {
  struct source_state state;
  struct source_event events[8];
  initialize(&state, events);
  prefix(&state, events, 7);
  struct source_event exit = {SOURCE_EXIT, SOURCE_OTHER, 78, 8, 107, state.hook, {0}};
  assert(source_apply(&state, &exit) == 1);
  assert(state.closed && state.hook_exited);
  events[7].global = 79;
  events[7].time = 108;
  assert(source_apply(&state, &events[7]) == 1);
  assert(!execution_present(state.consumer));
}
static void bounded_publication(void) {
  struct source_ready synthetic = {.ready = 1, .window = SOURCE_WINDOW_ACK};
  memset(&source_state, 0, sizeof(source_state));
  source_shared = &synthetic;
  source_queue_head = source_queue_length = 0;
  source_enqueue(SOURCE_PUBLISH_CLOSED);
  assert(!source_queue[0].deny_consumer);
  source_state.consumer_exited = 1;
  source_enqueue(SOURCE_PUBLISH_CLOSED);
  assert(source_queue[1].deny_consumer);
  memset(&source_state, 0, sizeof(source_state));
  source_queue_head = source_queue_length = 0;
  for (int i = 0; i < 4; i++)
    source_enqueue(SOURCE_PUBLISH_CLOSED);
  assert(source_queue_length == 4);
  assert(atomic_load(&synthetic.ready) == 1);
  source_enqueue(SOURCE_PUBLISH_CLOSED);
  assert(source_queue_length == 4);
  assert(source_state.closed && source_state.uncertain);
  assert(atomic_load(&synthetic.ready) == 0);
  assert(atomic_load(&synthetic.failed) == 1);
  source_enqueue(SOURCE_PUBLISH_CONSUMER);
  assert(source_queue_length == 4 && atomic_load(&synthetic.ready) == 0);
  source_shared = NULL;
}
static void callback_closure(void) {
  for (int failed = 0; failed < 2; failed++) {
    struct source_event events[8];
    initialize(&source_state, events);
    prefix(&source_state, events, 8);
    struct source_ready synthetic = {.ready = 1, .failed = failed, .window = SOURCE_WINDOW_VETO};
    source_shared = &synthetic;
    source_queue_head = source_queue_length = 0;
    es_process_t process = {.audit_token = execution(13, 3, 12, 2).token,
                            .parent_audit_token = execution(13, 3, 12, 2).parent,
                            .session_id = 10,
                            .start_time = {1013, 7}};
    es_message_t message = {.version = 4,
                            .global_seq_num = 79,
                            .seq_num = 8,
                            .mach_time = 108,
                            .action_type = ES_ACTION_TYPE_NOTIFY,
                            .event_type = ES_EVENT_TYPE_NOTIFY_EXIT,
                            .process = &process};
    source_message(&message); // Local packet only: no ES delivery, client or publication thread.
    assert(source_state.closed && source_state.uncertain == failed);
    assert(atomic_load(&synthetic.ready) == !failed);
    assert(atomic_load(&synthetic.failed) == failed);
    assert(source_state.consumer_exited == !failed);
    source_shared = NULL;
  }
}
static void terminal_binding(void) {
  struct timeval boot = {500, 9};
  struct source_admission hook = {.version = 1, .boot = boot, .hook = execution(13, 2, 12, 2)};
  struct source_admission admitted = hook;
  admitted.consumer = execution(13, 3, 12, 2);
  struct source_terminal terminal = {.original = admitted, .consumer_exited = 1};
  assert(source_terminal_matches(&terminal, &hook, boot, 0));
  assert(source_terminal_matches(&terminal, &admitted, boot, 1));
  assert(!source_terminal_matches(&terminal, &hook, boot, 1));
  terminal.uncertain = 1;
  assert(!source_terminal_matches(&terminal, &admitted, boot, 1));
  assert(!source_terminal_matches(&terminal, &hook, boot, 0));
  terminal.uncertain = terminal.consumer_exited = 0;
  assert(!source_terminal_matches(&terminal, &hook, boot, 0));
  terminal.hook_exited = 1;
  assert(source_terminal_matches(&terminal, &hook, boot, 0));
  terminal.original.hook.token.val[7] = 99;
  assert(!source_terminal_matches(&terminal, &hook, boot, 0));
  assert(!source_terminal_matches(&terminal, &hook, (struct timeval){501, 9}, 0));
  memset(&terminal.original.hook, 0, sizeof(terminal.original.hook));
  memset(&hook.hook, 0, sizeof(hook.hook));
  assert(!source_terminal_matches(&terminal, &hook, boot, 0));
}
static void completion_gates(void) {
  struct source_ready ready = {.version = 1, .ready = 1, .window = SOURCE_WINDOW_ACK};
  for (int record = SOURCE_RECORD_HOOK; record <= SOURCE_RECORD_TERMINAL; record++)
    assert(!source_completion_allows(&ready, record));
  atomic_store(&ready.completed[SOURCE_RECORD_ORIGINAL], 1);
  assert(source_completion_allows(&ready, SOURCE_RECORD_ORIGINAL));
  assert(!source_completion_allows(&ready, SOURCE_RECORD_ACK));
  atomic_store(&ready.completed[SOURCE_RECORD_ACK], 1);
  assert(source_completion_allows(&ready, SOURCE_RECORD_ACK));
  atomic_store(&ready.failed, 1);
  assert(!source_completion_allows(&ready, SOURCE_RECORD_ORIGINAL));
  assert(!source_completion_allows(&ready, SOURCE_RECORD_ACK));
  atomic_store(&ready.failed, 0);
  atomic_store(&ready.completed[SOURCE_RECORD_ACK], 2);
  assert(!source_completion_allows(&ready, SOURCE_RECORD_ACK));
  ready.version = 2;
  assert(!source_completion_allows(&ready, SOURCE_RECORD_ORIGINAL));
}
int main(void) {
  bounded_publication();
  original_and_ack();
  refuse_contradictions();
  hook_exit();
  callback_closure();
  terminal_binding();
  completion_gates();
  puts("{\"scope\":\"local synthetic state, callback, publication queue, ACK and terminal "
       "predicates "
       "only\",\"cases\":14}");
  return 0;
}
