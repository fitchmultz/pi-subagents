// Bounded in-process publication; the ES callback does no filesystem I/O.
#include "protected-macos-prejob.h"
#include <pthread.h>
static pthread_mutex_t source_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t source_publication_ready = PTHREAD_COND_INITIALIZER;
static struct source_state source_state;
static struct timeval source_boot;
static struct source_ready *source_shared;
static pthread_t source_publisher;
enum source_publication_kind {
  SOURCE_PUBLISH_HOOK,
  SOURCE_PUBLISH_CONSUMER,
  SOURCE_PUBLISH_CLOSED
};
struct source_publication {
  enum source_publication_kind kind;
  int deny_consumer;
  struct source_admission original;
};
static struct source_publication source_queue[4];
static size_t source_queue_head, source_queue_length;
static int source_publisher_stopping;
static struct source_admission source_snapshot(void) {
  return (struct source_admission){.version = 1,
                                   .boot = source_boot,
                                   .anchor_global = source_state.anchor_global,
                                   .anchor_fork_sequence = source_state.anchor_fork_sequence,
                                   .admitted_global = source_state.global,
                                   .admitted_exec_sequence = source_state.sequences[SOURCE_EXEC],
                                   .mach_time = source_state.time,
                                   .launch_child = source_state.launch_child,
                                   .launcher = source_state.launcher,
                                   .listener = source_state.listener,
                                   .worker = source_state.worker,
                                   .hook = source_state.hook,
                                   .consumer = source_state.consumer};
}
static void source_invalidate(void) {
  source_fail(&source_state);
  atomic_store_explicit(&source_shared->failed, 1, memory_order_release);
  atomic_store_explicit(&source_shared->ready, 0, memory_order_release);
}
static void source_enqueue(enum source_publication_kind kind) {
  if (source_queue_length == 4) {
    source_invalidate();
  } else {
    size_t index = (source_queue_head + source_queue_length) % 4;
    int deny = atomic_load(&source_shared->window) != SOURCE_WINDOW_ACK || source_state.uncertain ||
               source_state.hook_exited || source_state.consumer_exited;
    source_queue[index] = (struct source_publication){kind, deny, source_snapshot()};
    source_queue_length++;
  }
  pthread_cond_signal(&source_publication_ready);
}
static int source_publish(const struct source_publication *publication) {
  int failed = atomic_load(&source_shared->failed);
  if (publication->kind == SOURCE_PUBLISH_CLOSED && !publication->deny_consumer && !failed)
    return 0; // ACK closes capture, but the exact original consumer must still consume it.
  if (publication->kind == SOURCE_PUBLISH_CLOSED || failed)
    return protected_file(HOOK_ROOT "/closed", "source-lifetime-closed\n") == 2 ? 2 : 0;
  const char *path =
      publication->kind == SOURCE_PUBLISH_HOOK ? SOURCE_HOOK_RECORD : SOURCE_ADMISSION;
  enum source_record record =
      publication->kind == SOURCE_PUBLISH_HOOK ? SOURCE_RECORD_HOOK : SOURCE_RECORD_ORIGINAL;
  int result = protected_commit_bytes(path, &publication->original, sizeof(publication->original),
                                      &source_shared->completed[record]);
  if (result == 1) {
    struct source_admission saved;
    return source_read(path, &saved, sizeof(saved)) ||
                   memcmp(&saved, &publication->original, sizeof(saved))
               ? 2
               : 0;
  }
  return result;
}
static void *source_publish_loop(void *unused) {
  (void)unused;
  for (;;) {
    pthread_mutex_lock(&source_mutex);
    while (!source_queue_length && !source_publisher_stopping)
      pthread_cond_wait(&source_publication_ready, &source_mutex);
    if (!source_queue_length) {
      pthread_mutex_unlock(&source_mutex);
      return NULL;
    }
    struct source_publication publication = source_queue[source_queue_head];
    source_queue_head = (source_queue_head + 1) % 4;
    source_queue_length--;
    pthread_mutex_unlock(&source_mutex);
    if (source_publish(&publication)) {
      pthread_mutex_lock(&source_mutex);
      source_invalidate();
      pthread_mutex_unlock(&source_mutex);
      (void)protected_file(HOOK_ROOT "/closed", "source-persistence-failed\n");
    }
  }
}
static int source_publication_start(struct timeval boot) {
  source_boot = boot;
  struct source_ready ready = {.version = 1, .boot = boot, .owner = source_state.owner};
  struct proc_bsdinfo info;
  if (proc_pidinfo(getpid(), PROC_PIDTBSDINFO, 1, &info, sizeof(info)) != sizeof(info) ||
      info.pbi_pid != getpid() || info.pbi_uid != 0)
    return 2;
  ready.native =
      (struct cut){getpid(), 0, getsid(getpid()), info.pbi_start_tvsec, info.pbi_start_tvusec};
  if (ready.native.sid <= 0)
    return 2;
  if (protected_bytes(SOURCE_READY, &ready, sizeof(ready)))
    return 2;
  source_shared = source_mapping(1);
  if (!source_shared)
    return 2;
  if (pthread_create(&source_publisher, NULL, source_publish_loop, NULL)) {
    source_invalidate();
    munmap(source_shared, sizeof(*source_shared));
    source_shared = NULL;
    return 2;
  }
  return 0;
}
static int source_publication_stop(void) {
  pthread_mutex_lock(&source_mutex);
  source_publisher_stopping = 1;
  pthread_cond_signal(&source_publication_ready);
  pthread_mutex_unlock(&source_mutex);
  return pthread_join(source_publisher, NULL) ? 2 : 0;
}
