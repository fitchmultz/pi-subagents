// Read-only native pre-job guard, compiled into the existing root observer.
#include "protected-macos-files.h"
#include "protected-macos-runner-inputs.h"
#include "protected-macos-sockets.h"
#include <fcntl.h>
#include <time.h>
#define HOOK_ROOT "/Library/ProtectedCIHooks"
#define HOOK_PATH HOOK_ROOT "/job-started.sh"
#define JOB_ROOT "/Users/ci/.protected-job"
#define WORKER_PATH "/Users/ci/runner/bin/Runner.Worker"
#define LISTENER_PATH "/Users/ci/runner/bin/Runner.Listener"
#include "protected-macos-arguments.h"
#include "protected-macos-lifecycle.h"
#include "protected-macos-source-identity.h"
struct job_config {
  char operation[37], nonce[65], runner[129], worker[65];
};
static int config_read(struct job_config *config) {
  int fd = open("/Library/ProtectedCI/job.bin", O_RDONLY | O_NOFOLLOW);
  struct stat st;
  if (fd < 0)
    return 2;
  if (fstat(fd, &st) || st.st_uid || !S_ISREG(st.st_mode) || st.st_size != sizeof(*config)) {
    close(fd);
    return 2;
  }
  ssize_t used = read(fd, config, sizeof(*config));
  close(fd);
  return used == sizeof(*config) ? 0 : 2;
}
static int job_close(void) {
  int failed = source_window_update(SOURCE_WINDOW_CLOSED);
  int result = protected_file(HOOK_ROOT "/closed", "closed\n");
  if (result == 2 || failed)
    return 2;
  puts("{\"windowClosed\":true}");
  return 0;
}
static int alphabet(const char *s, const char *characters, size_t length) {
  return strlen(s) == length && strspn(s, characters) == length;
}
static int prepare_job(int argc, char **argv) {
  if (!source_platform_available())
    return 2;
  if (argc != 6 || !alphabet(argv[2], "0123456789abcdef-", 36) ||
      !alphabet(argv[3], "0123456789abcdef", 64) || strlen(argv[4]) > 128 ||
      strspn(argv[4], "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") !=
          strlen(argv[4]) ||
      !alphabet(argv[5], "0123456789abcdef", 64))
    return 2;
  struct job_config config = {0};
  strcpy(config.operation, argv[2]);
  strcpy(config.nonce, argv[3]);
  strcpy(config.runner, argv[4]);
  strcpy(config.worker, argv[5]);
  int result = protected_bytes("/Library/ProtectedCI/job.bin", &config, sizeof(config));
  if (result == 2)
    return 2;
  if (result == 1) {
    struct job_config saved;
    if (config_read(&saved) || memcmp(&saved, &config, sizeof(config)) ||
        !access(HOOK_ROOT "/closed", F_OK) || !access(HOOK_ROOT "/ack", F_OK) ||
        !access(SOURCE_ACK, F_OK) || !access(JOB_ROOT "/capture", F_OK))
      return 2;
  }
  if (mkdir(JOB_ROOT, 0700) && errno != EEXIST)
    return 2;
  struct stat directory;
  if (lstat(JOB_ROOT, &directory) || !S_ISDIR(directory.st_mode) || chown(JOB_ROOT, 502, 20))
    return 2;
  char content[512];
  snprintf(content, sizeof(content), "OPERATION_ID='%s'\nNONCE='%s'\nEXPECTED_RUNNER='%s'\n",
           config.operation, config.nonce, config.runner);
  int published = protected_file(HOOK_ROOT "/job.conf", content);
  if (published == 2)
    return 2;
  if (published == 1) {
    char saved[512] = {0};
    int fd = open(HOOK_ROOT "/job.conf", O_RDONLY | O_NOFOLLOW);
    if (fd < 0)
      return 2;
    int failed = read(fd, saved, sizeof(saved) - 1) != strlen(content) || strcmp(saved, content);
    close(fd);
    if (failed)
      return 2;
  }
  puts("{\"gatePrepared\":true}");
  return 0;
}
static int hook_arguments(struct observed hook) {
  char buffer[262144], *args[64];
  int count = 0;
  if (!hook.path[0])
    return 2;
  if (strcmp(hook.path, SOURCE_BINARY))
    return 1;
  if (arguments(hook.identity.pid, buffer, sizeof(buffer), args, &count))
    return 2;
  return count == 3 && !strcmp(args[0], SOURCE_BINARY) && !strcmp(args[1], "--job-consume") &&
                 alphabet(args[2], "0123456789abcdef", 64)
             ? 0
             : 1;
}
static int runner_arguments(struct observed runner, int worker) {
  char buffer[262144], *args[64];
  int count = 0;
  if (arguments(runner.identity.pid, buffer, sizeof(buffer), args, &count))
    return 2;
  if (strcmp(args[0], worker ? WORKER_PATH : LISTENER_PATH))
    return 1;
  if (worker)
    return count == 4 && !strcmp(args[1], "spawnclient") ? 0 : 1;
  return count == 2 && !strcmp(args[1], "run") ? 0 : 1;
}
static int chain(struct observed hook, struct observed *worker, struct observed *listener,
                 struct timeval boot) {
  int result = hook_arguments(hook);
  if (result)
    return result;
  if (identity(hook.info.pbi_ppid, worker))
    return 2;
  if (!worker->path[0])
    return 2;
  if (strcmp(worker->path, WORKER_PATH))
    return 1;
  result = runner_arguments(*worker, 1);
  if (result)
    return result;
  if (identity(worker->info.pbi_ppid, listener))
    return 2;
  if (!listener->path[0])
    return 2;
  if (strcmp(listener->path, LISTENER_PATH))
    return 1;
  result = runner_arguments(*listener, 0);
  if (result)
    return result;
  if (hook.identity.sid != worker->identity.sid || worker->identity.sid != listener->identity.sid)
    return 1;
  struct cut admitted;
  size_t count = 1;
  if (read_cut("/Library/ProtectedCI/listener.bin", boot, &admitted, &count) || count != 1)
    return 2;
  // The prospective owner launched this exact child; shell ancestors cannot substitute for it.
  return equal(listener->identity, admitted) ? 0 : 1;
}
static int artifact(char *buffer, size_t capacity) {
  int users = open("/Users", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  int ci = openat(users, "ci", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  int directory = openat(ci, ".protected-job", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  int fd = openat(directory, "capture", O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  close(users);
  close(ci);
  close(directory);
  if (fd < 0)
    return errno == ENOENT ? 1 : 2;
  struct stat st;
  if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_uid != 502 || st.st_nlink != 1 ||
      st.st_size <= 0 || st.st_size >= capacity) {
    close(fd);
    return 2;
  }
  ssize_t used = read(fd, buffer, capacity - 1);
  close(fd);
  if (used != st.st_size)
    return 2;
  buffer[used] = 0;
  return 0;
}
static int veto(const char *code, struct observed *hook) {
  int failed = source_window_update(SOURCE_WINDOW_VETO);
  int result = protected_file(HOOK_ROOT "/closed", "guard-veto\n");
  if (result == 2 || failed)
    return 2;
  printf("{\"veto\":true,\"code\":");
  text(code);
  printf(",\"noAck\":%s,\"windowClosed\":true",
         access(HOOK_ROOT "/ack", F_OK) && access(SOURCE_ACK, F_OK) ? "true" : "false");
  if (hook) {
    struct timeval boot;
    if (!hook_arguments(*hook) && !boot_time(&boot)) {
      if (write_cut("/Library/ProtectedCI/veto-hook.bin", boot, &hook->identity, 1))
        return 2;
      printf(",\"hookVerified\":true");
    }
    printf(",\"hookIdentity\":");
    print_entry(*hook, 0);
  }
  puts("}");
  return 0;
}
static void print_capture(const struct job_config *config, char *const fields[12],
                          struct observed hook, const char *hash) {
  printf("{\"guarded\":true,\"runnerVersion\":\"2.338.0\",\"workerSHA256\":\"%s\",\"operationID\":"
         "\"%s\",\"nonce\":\"%s\",\"runnerName\":\"%s\",\"hookIdentity\":",
         hash, config->operation, config->nonce, config->runner);
  print_entry(hook, 0);
  printf(",\"github\":{\"repository\":");
  text(fields[4]);
  printf(",\"sha\":");
  text(fields[5]);
  printf(",\"ref\":");
  text(fields[6]);
  printf(",\"eventName\":");
  text(fields[7]);
  printf(",\"runId\":");
  text(fields[8]);
  printf(",\"attempt\":");
  text(fields[9]);
  printf(",\"jobRef\":");
  text(fields[10]);
  printf(",\"workflowRef\":");
  text(fields[11]);
  puts("}}");
}
static int closed_capture(struct timeval boot) {
  if (source_health_failed(boot))
    return 2;
  struct source_admission hook_source;
  if (access(HOOK_ROOT "/ack", F_OK) && access(SOURCE_ACK, F_OK) &&
      source_committed(SOURCE_RECORD_HOOK) &&
      !source_read(SOURCE_HOOK_RECORD, &hook_source, sizeof(hook_source)) &&
      hook_source.version == 1 && hook_source.boot.tv_sec == boot.tv_sec &&
      hook_source.boot.tv_usec == boot.tv_usec) {
    if (write_cut("/Library/ProtectedCI/veto-hook.bin", boot, &hook_source.hook.native, 1))
      return 2;
    puts("{\"veto\":true,\"code\":\"original-lifetime\",\"hookVerified\":true,"
         "\"noAck\":true,\"windowClosed\":true}");
    return 0;
  }
  puts("{\"windowClosed\":true}");
  return 0;
}
static int capture_fields(char *buffer, char *fields[12], const struct job_config *config) {
  char *p = buffer;
  for (int i = 0; i < 12; i++) {
    fields[i] = p;
    char *end = strchr(p, '\n');
    if (!end)
      return veto("invalid-capture", NULL) ? 2 : 1;
    *end = 0;
    p = end + 1;
  }
  if (*p || strcmp(fields[1], config->operation) || strcmp(fields[2], config->nonce) ||
      strcmp(fields[3], config->runner) || strcmp(fields[4], "fitchmultz/pi-subagents") ||
      !alphabet(fields[5], "0123456789abcdef", 40))
    return veto("context-mismatch", NULL) ? 2 : 1;
  return 0;
}
static int acknowledge_capture(const struct source_admission *original,
                               const struct job_config *config, const char *nonce) {
  if (!nonce || strcmp(nonce, config->nonce) || source_publish_ack(original, config->nonce))
    return 2;
  puts("{\"acked\":true,\"windowClosed\":true}");
  return 0;
}
static int capture_job(struct timeval boot, int acknowledge, const char *nonce) {
  struct job_config config;
  if (config_read(&config) || source_health_failed(boot))
    return 2;
  if (!access(HOOK_ROOT "/closed", F_OK))
    return closed_capture(boot);
  if (!access(HOOK_ROOT "/ack", F_OK)) {
    struct source_ack ack;
    if (!source_owner_live() || !source_window_permits(1) ||
        source_ack_record(boot, config.nonce, &ack))
      return 2;
    puts("{\"acked\":true,\"windowClosed\":true}");
    return 0;
  }
  char buffer[65536], repeated[65536];
  int result = artifact(buffer, sizeof(buffer));
  if (result == 1) {
    puts("{\"pending\":true}");
    return 0;
  }
  if (result)
    return 2;
  struct source_admission original_source;
  result = source_original(boot, &original_source);
  if (result) {
    if (result == 1) {
      puts("{\"pending\":true}");
      return 0;
    }
    return 2;
  }
  char original[65536];
  strcpy(original, buffer);
  char *fields[12];
  result = capture_fields(buffer, fields, &config);
  if (result)
    return result == 2 ? 2 : 0;
  char *end;
  long pid = strtol(fields[0], &end, 10);
  struct observed hook, worker, listener;
  if (*end || pid != original_source.consumer.native.pid)
    return veto("original-execution", NULL);
  if (identity((int)pid, &hook)) {
    job_close();
    return 0;
  }
  if (!equal(hook.identity, original_source.hook.native))
    return veto("original-execution", NULL);
  result = chain(hook, &worker, &listener, boot);
  if (result == 2)
    return 2;
  if (result)
    return veto("native-chain", &hook);
  if (!equal(worker.identity, original_source.worker.native) ||
      !equal(listener.identity, original_source.listener.native))
    return veto("original-ancestry", &hook);
  char hash[65];
  if (hash_file(WORKER_PATH, hash))
    return 2;
  result = reviewed_inputs();
  if (result == 2)
    return 2;
  if (strcmp(hash, config.worker) || result)
    return veto("worker-integrity", &hook);
  int w = no_listeners(worker), l = no_listeners(listener);
  if (w == 2 || l == 2)
    return 2;
  if (w || l)
    return veto("native-listener", &hook);
  struct observed h2, w2, l2;
  if (identity(hook.identity.pid, &h2) || identity(worker.identity.pid, &w2) ||
      identity(listener.identity.pid, &l2) || !equal(hook.identity, h2.identity) ||
      !equal(worker.identity, w2.identity) || !equal(listener.identity, l2.identity) ||
      hook.info.pbi_ppid != h2.info.pbi_ppid || worker.info.pbi_ppid != w2.info.pbi_ppid ||
      artifact(repeated, sizeof(repeated)) || strcmp(original, repeated))
    return 2;
  if (acknowledge)
    return acknowledge_capture(&original_source, &config, nonce);
  print_capture(&config, fields, hook, hash);
  return 0;
}
static int idle_set(struct timeval boot, struct observed listener) {
  struct observed *a = calloc(CAPACITY, sizeof(*a)), *b = calloc(CAPACITY, sizeof(*b));
  struct cut *cut = calloc(CAPACITY, sizeof(*cut));
  size_t n = CAPACITY, x = 0, y = 0;
  if (!a || !b || !cut || read_cut("/Library/ProtectedCI/baseline.bin", boot, cut, &n) ||
      collect(a, &x) || collect(b, &y) || x != y)
    return 2;
  int result = 0;
  for (size_t i = 0; i < x; i++) {
    if (!equal(a[i].identity, b[i].identity)) {
      result = 2;
      break;
    }
    int known = equal(listener.identity, b[i].identity);
    for (size_t j = 0; j < n; j++)
      if (equal(cut[j], b[i].identity))
        known = 1;
    if (!known) {
      result = 1;
      break;
    }
  }
  free(a);
  free(b);
  free(cut);
  return result;
}
static int idle_drain(struct timeval boot) {
  if (!access(HOOK_ROOT "/ack", F_OK) || !access(SOURCE_ACK, F_OK) ||
      !access(JOB_ROOT "/capture", F_OK))
    return 1;
  struct cut saved;
  size_t count = 1;
  struct observed listener, after;
  if (read_cut("/Library/ProtectedCI/listener.bin", boot, &saved, &count) || count != 1)
    return 2;
  if (identity(saved.pid, &listener)) {
    if (kill(saved.pid, 0) != -1 || errno != ESRCH)
      return 2;
    puts("{\"idleListenerAbsent\":true}");
    return 0;
  }
  if (!equal(saved, listener.identity) || strcmp(listener.path, LISTENER_PATH) ||
      runner_arguments(listener, 0) || reviewed_inputs() || no_listeners(listener) ||
      idle_set(boot, listener))
    return 2;
  if (protected_file(HOOK_ROOT "/closed", "idle-drain\n") == 2)
    return 2;
  // Freeze only the authenticated idle Listener; then rule out a check/fork race.
  if (write_cut("/Library/ProtectedCI/idle-suspended.bin", boot, &saved, 1))
    return 2;
  if (identity(saved.pid, &after) || !equal(saved, after.identity) || kill(saved.pid, SIGSTOP))
    return 2;
  int stopped = 0;
  for (int i = 0; i < 100; i++) {
    if (identity(saved.pid, &after) || !equal(saved, after.identity))
      return 2;
    if (after.info.pbi_status == 4) {
      stopped = 1;
      break;
    }
    struct timespec delay = {0, 10000000};
    nanosleep(&delay, NULL);
  }
  int safe = stopped && !strcmp(after.path, LISTENER_PATH) && !runner_arguments(after, 0) &&
             !reviewed_inputs() && !no_listeners(after) && !idle_set(boot, after) &&
             access(JOB_ROOT "/capture", F_OK) && access(HOOK_ROOT "/ack", F_OK) &&
             access(SOURCE_ACK, F_OK);
  if (identity(saved.pid, &after) || !equal(saved, after.identity))
    return 2;
  if (!safe) {
    if (kill(saved.pid, SIGCONT))
      return 2;
    puts("{\"idleDrainVetoed\":true,\"listenerResumed\":true}");
    return 1;
  }
  if (kill(saved.pid, SIGKILL))
    return 2;
  puts("{\"stoppedIdleListener\":true}");
  return 0;
}
static int prejob(int argc, char **argv, struct timeval boot) {
  if (!strcmp(argv[1], "--job-prepare"))
    return prepare_job(argc, argv);
  if (argc == 2 && !strcmp(argv[1], "--job-close"))
    return job_close();
  if (argc == 2 && !strcmp(argv[1], "--job-drain"))
    return idle_drain(boot);
  if (argc == 2 && !strcmp(argv[1], "--job-reviewed-inputs")) {
    int result = reviewed_inputs();
    printf("{\"reviewedInputs\":%s,\"runnerVersion\":\"2.338.0\",\"manifestSHA256\":"
           "\"815f038d30beb579a5e2873170c14ed27f55a4815b48c6ca16b1c9b9ef4afa43\"}\n",
           result ? "false" : "true");
    return result;
  }
  if (argc == 2 && !strcmp(argv[1], "--job-capture"))
    return capture_job(boot, 0, NULL);
  if (argc == 3 && !strcmp(argv[1], "--job-ack"))
    return capture_job(boot, 1, argv[2]);
  if (argc == 2 && !strcmp(argv[1], "--job-veto-status")) {
    struct cut hook;
    size_t count = 1;
    struct observed observed;
    if (access(HOOK_ROOT "/closed", F_OK) || !access(HOOK_ROOT "/ack", F_OK) ||
        !access(SOURCE_ACK, F_OK) ||
        read_cut("/Library/ProtectedCI/veto-hook.bin", boot, &hook, &count) || count != 1)
      return 2;
    if (!identity(hook.pid, &observed)) {
      if (!equal(hook, observed.identity))
        return 2;
      puts("{\"hookFailed\":false,\"noAck\":true,\"windowClosed\":true}");
      return 0;
    }
    if (kill(hook.pid, 0) != -1 || errno != ESRCH || source_veto_exit(boot, hook))
      return 2;
    puts("{\"hookFailed\":true,\"noAck\":true,\"windowClosed\":true}");
    return 0;
  }
  if (argc == 3 && !strcmp(argv[1], "--job-sockets")) {
    char *end;
    long pid = strtol(argv[2], &end, 10);
    struct observed entry;
    if (*end || pid <= 0 || pid > 2147483647 || identity((int)pid, &entry))
      return 2;
    int result = no_listeners(entry);
    printf("{\"noListeners\":%s,\"uncertain\":%s,\"identity\":", result ? "false" : "true",
           result == 2 ? "true" : "false");
    print_entry(entry, 0);
    if (result == 1)
      printf(",\"listeningSocket\":{\"fd\":%d,\"family\":%d,\"kind\":%d,\"tcpState\":%d,"
             "\"options\":%d}",
             listening.fd, listening.family, listening.kind, listening.tcp_state,
             listening.options);
    puts("}");
    return result;
  }
  return 2;
}
