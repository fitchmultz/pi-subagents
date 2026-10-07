// Root-owned admissions and readonly shared health; no CI write/control channel.
#include <Security/Security.h>
#include <mach/mach.h>
#include <stdatomic.h>
#include <sys/mman.h>
#define SOURCE_BINARY "/Library/ProtectedCIHooks/observer"
#define SOURCE_OWNER "/Library/ProtectedCI/source-owner"
#define SOURCE_READY "/Library/ProtectedCIHooks/source-ready.bin"
#define SOURCE_ADMISSION "/Library/ProtectedCIHooks/source-original.bin"
#define SOURCE_HOOK_RECORD "/Library/ProtectedCIHooks/source-hook.bin"
#define SOURCE_TERMINAL "/Library/ProtectedCIHooks/source-terminal.bin"
#define SOURCE_ACK "/Library/ProtectedCIHooks/ack.bin"
enum source_window {
  SOURCE_WINDOW_OPEN,
  SOURCE_WINDOW_ACK,
  SOURCE_WINDOW_CLOSED,
  SOURCE_WINDOW_VETO
};
enum source_record {
  SOURCE_RECORD_HOOK,
  SOURCE_RECORD_ORIGINAL,
  SOURCE_RECORD_ACK,
  SOURCE_RECORD_TERMINAL
};
struct source_ready {
  uint32_t version;
  struct timeval boot;
  audit_token_t owner;
  struct cut native;
  _Atomic uint32_t ready, failed, window;
  _Atomic uint32_t completed[4];
};
struct source_terminal {
  struct source_admission original;
  uint32_t uncertain, hook_exited, consumer_exited;
};
static int source_terminal_matches(const struct source_terminal *terminal,
                                   const struct source_admission *original, struct timeval boot,
                                   int consumer_required) {
  return terminal->original.version == 1 && original->version == 1 &&
         execution_present(original->hook) && terminal->hook_exited <= 1 &&
         terminal->consumer_exited <= 1 && terminal->original.boot.tv_sec == boot.tv_sec &&
         terminal->original.boot.tv_usec == boot.tv_usec && original->boot.tv_sec == boot.tv_sec &&
         original->boot.tv_usec == boot.tv_usec && !terminal->uncertain &&
         token_equal(terminal->original.hook.token, original->hook.token) &&
         (consumer_required
              ? terminal->consumer_exited && execution_present(original->consumer) &&
                    token_equal(terminal->original.consumer.token, original->consumer.token)
              : terminal->hook_exited ||
                    (terminal->consumer_exited && execution_present(terminal->original.consumer)));
}
_Static_assert(ATOMIC_INT_LOCK_FREE == 2, "Shared source health requires lock-free native atomics");
static int source_platform_available(void) {
  if (__builtin_available(macOS 27.0, *))
    return 1;
  fputs("boundary=EndpointSecurity-ordering requires-macOS27 unavailable\n", stderr);
  return 0;
}
static int source_readonly_fd(const char *path, size_t length) {
  int fd = regular_path(path);
  struct stat info;
  if (fd < 0)
    return -1;
  if (fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_uid || (info.st_mode & 0777) != 0444 ||
      info.st_nlink != 1 || info.st_size != length) {
    close(fd);
    errno = EINVAL;
    return -1;
  }
  return fd;
}
static int source_read(const char *path, void *value, size_t length) {
  int fd = source_readonly_fd(path, length);
  if (fd < 0)
    return 2;
  int failed = read(fd, value, length) != length;
  close(fd);
  return failed ? 2 : 0;
}
static struct source_ready *source_mapping(int writable) {
  if (writable && geteuid() != 0)
    return NULL;
  int fd = source_readonly_fd(SOURCE_READY, sizeof(struct source_ready));
  if (fd < 0)
    return NULL;
  if (writable) {
    int writer = open(SOURCE_READY, O_RDWR | O_NOFOLLOW);
    struct stat before, after;
    if (writer < 0 || fstat(fd, &before) || fstat(writer, &after) ||
        before.st_dev != after.st_dev || before.st_ino != after.st_ino) {
      if (writer >= 0)
        close(writer);
      close(fd);
      return NULL;
    }
    close(fd);
    fd = writer;
  }
  void *mapped = mmap(NULL, sizeof(struct source_ready), PROT_READ | (writable ? PROT_WRITE : 0),
                      MAP_SHARED, fd, 0);
  close(fd);
  return mapped == MAP_FAILED ? NULL : mapped;
}
static int source_completion_allows(const struct source_ready *ready, enum source_record record) {
  return ready->version == 1 && !atomic_load_explicit(&ready->failed, memory_order_acquire) &&
         atomic_load_explicit(&ready->completed[record], memory_order_acquire) == 1;
}
static int source_committed(enum source_record record) {
  struct source_ready *ready = source_mapping(0);
  if (!ready)
    return 0;
  int committed = source_completion_allows(ready, record);
  munmap(ready, sizeof(*ready));
  return committed;
}
static int source_number(CFDictionaryRef information, CFStringRef key, int32_t *value) {
  CFNumberRef number = CFDictionaryGetValue(information, key);
  return number && CFGetTypeID(number) == CFNumberGetTypeID() &&
         CFNumberGetValue(number, kCFNumberSInt32Type, value);
}
static int source_safe_entitlements(CFDictionaryRef information) {
  CFDictionaryRef entitlements = CFDictionaryGetValue(information, kSecCodeInfoEntitlementsDict);
  if (!entitlements || CFGetTypeID(entitlements) != CFDictionaryGetTypeID())
    return 0;
  const CFStringRef unsafe[] = {CFSTR("com.apple.security.get-task-allow"),
                                CFSTR("com.apple.security.cs.disable-library-validation"),
                                CFSTR("com.apple.security.cs.allow-dyld-environment-variables"),
                                CFSTR("com.apple.security.cs.allow-unsigned-executable-memory")};
  for (size_t i = 0; i < sizeof(unsafe) / sizeof(*unsafe); i++) {
    CFTypeRef value = CFDictionaryGetValue(entitlements, unsafe[i]);
    if (value && value != kCFBooleanFalse)
      return 0;
  }
  return 1;
}
static int source_immutable_code(SecCodeRef code) {
  CFDictionaryRef information = NULL;
  if (SecCodeCopySigningInformation(code, kSecCSDynamicInformation, &information) || !information)
    return 2;
  int32_t signature = 0, dynamic = 0;
  uint32_t required = kSecCodeSignatureForceHard | kSecCodeSignatureForceKill |
                      kSecCodeSignatureRuntime | kSecCodeSignatureLibraryValidation |
                      kSecCodeSignatureRestrict;
  int valid = source_number(information, kSecCodeInfoFlags, &signature) &&
              source_number(information, kSecCodeInfoStatus, &dynamic) &&
              ((uint32_t)signature & required) == required &&
              !(signature & kSecCodeSignatureAdhoc) && !(dynamic & kSecCodeStatusDebugged) &&
              source_safe_entitlements(information);
  CFRelease(information);
  return valid ? 0 : 2;
}
static int source_live(audit_token_t token) {
  CFDataRef data = CFDataCreate(NULL, (const UInt8 *)&token, sizeof(token));
  if (!data)
    return 2;
  const void *key = kSecGuestAttributeAudit, *value = data;
  CFDictionaryRef attributes = CFDictionaryCreate(
      NULL, &key, &value, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  SecCodeRef code = NULL;
  OSStatus result = attributes ? SecCodeCopyGuestWithAttributes(NULL, attributes, 0, &code) : -1;
  if (!result)
    result = SecCodeCheckValidity(code, 0, NULL);
  if (!result)
    result = source_immutable_code(code);
  if (code)
    CFRelease(code);
  if (attributes)
    CFRelease(attributes);
  CFRelease(data);
  return result ? 2 : 0;
}
static int source_root_identity(const struct source_ready *ready) {
  struct proc_bsdinfo info;
  char path[PROC_PIDPATHINFO_MAXSIZE];
  if (ready->native.uid != 0 || audit_token_to_pid(ready->owner) != ready->native.pid ||
      proc_pidinfo(ready->native.pid, PROC_PIDTBSDINFO, 1, &info, sizeof(info)) != sizeof(info) ||
      info.pbi_uid != 0 || info.pbi_pid != ready->native.pid ||
      getsid(ready->native.pid) != ready->native.sid ||
      info.pbi_start_tvsec != ready->native.seconds ||
      info.pbi_start_tvusec != ready->native.microseconds ||
      proc_pidpath(ready->native.pid, path, sizeof(path)) <= 0 || strcmp(path, SOURCE_BINARY))
    return 2;
  // This trusted root owner never execs. Birth/UID/SID plus immutable code is a separate witness.
  return source_live(ready->owner);
}
static int source_owner_live(void) {
  struct source_ready *ready = source_mapping(0);
  if (!ready)
    return 0;
  struct timeval boot;
  int live = ready->version == 1 && audit_token_to_euid(ready->owner) == 0 && !boot_time(&boot) &&
             ready->boot.tv_sec == boot.tv_sec && ready->boot.tv_usec == boot.tv_usec &&
             atomic_load_explicit(&ready->ready, memory_order_acquire) &&
             !atomic_load_explicit(&ready->failed, memory_order_acquire) &&
             !source_root_identity(ready);
  munmap(ready, sizeof(*ready));
  return live;
}
static int source_window_update(enum source_window window) {
  struct source_ready *ready = source_mapping(1);
  if (!ready)
    return errno == ENOENT && window != SOURCE_WINDOW_ACK ? 0 : 2;
  uint32_t expected = SOURCE_WINDOW_OPEN;
  if (window == SOURCE_WINDOW_ACK && (!atomic_load(&ready->ready) || atomic_load(&ready->failed))) {
    munmap(ready, sizeof(*ready));
    return 2;
  }
  int changed = atomic_compare_exchange_strong(&ready->window, &expected, window);
  if (window != SOURCE_WINDOW_ACK)
    atomic_store_explicit(&ready->window, window, memory_order_release);
  int failed = msync(ready, sizeof(*ready), MS_SYNC);
  if (failed) {
    atomic_store_explicit(&ready->failed, 1, memory_order_release);
    atomic_store_explicit(&ready->ready, 0, memory_order_release);
  }
  munmap(ready, sizeof(*ready));
  return failed || (window == SOURCE_WINDOW_ACK && !changed) ? 2 : 0;
}
static void source_publication_failed(void) {
  struct source_ready *ready = source_mapping(1);
  if (!ready)
    return;
  atomic_store_explicit(&ready->failed, 1, memory_order_release);
  atomic_store_explicit(&ready->ready, 0, memory_order_release);
  atomic_store_explicit(&ready->window, SOURCE_WINDOW_VETO, memory_order_release);
  (void)msync(ready, sizeof(*ready), MS_ASYNC);
  munmap(ready, sizeof(*ready));
}
static int source_window_permits(int consuming) {
  struct source_ready *ready = source_mapping(0);
  if (!ready)
    return 0;
  uint32_t window = atomic_load_explicit(&ready->window, memory_order_acquire);
  int open = window == SOURCE_WINDOW_OPEN || (consuming && window == SOURCE_WINDOW_ACK);
  munmap(ready, sizeof(*ready));
  return open;
}
static int source_health_failed(struct timeval boot) {
  struct source_ready *ready = source_mapping(0);
  if (!ready)
    return 1;
  int failed = ready->version != 1 || ready->boot.tv_sec != boot.tv_sec ||
               ready->boot.tv_usec != boot.tv_usec || atomic_load(&ready->failed);
  munmap(ready, sizeof(*ready));
  return failed;
}
static int source_veto_exit(struct timeval boot, struct cut hook) {
  struct source_terminal terminal;
  struct source_admission original;
  return source_health_failed(boot) || !source_committed(SOURCE_RECORD_HOOK) ||
                 !source_committed(SOURCE_RECORD_TERMINAL) ||
                 source_read(SOURCE_TERMINAL, &terminal, sizeof(terminal)) ||
                 source_read(SOURCE_HOOK_RECORD, &original, sizeof(original)) ||
                 !source_terminal_matches(&terminal, &original, boot, 0) ||
                 !equal(hook, original.hook.native)
             ? 2
             : 0;
}
static int source_original(struct timeval boot, struct source_admission *original) {
  if (!source_owner_live() || !source_window_permits(0))
    return 2;
  if (!source_committed(SOURCE_RECORD_ORIGINAL))
    return 1;
  if (source_read(SOURCE_ADMISSION, original, sizeof(*original)) || original->version != 1 ||
      original->boot.tv_sec != boot.tv_sec || original->boot.tv_usec != boot.tv_usec ||
      !execution_present(original->consumer) || source_live(original->consumer.token))
    return 2;
  return 0;
}
static int source_ack_record(struct timeval boot, const char *nonce, struct source_ack *ack) {
  struct source_admission original;
  if (source_health_failed(boot) || !source_committed(SOURCE_RECORD_ORIGINAL) ||
      !source_committed(SOURCE_RECORD_ACK) || source_read(SOURCE_ACK, ack, sizeof(*ack)) ||
      source_read(SOURCE_ADMISSION, &original, sizeof(original)) || original.version != 1 ||
      original.boot.tv_sec != boot.tv_sec || original.boot.tv_usec != boot.tv_usec ||
      memcmp(&original, &ack->original, sizeof(original)) ||
      strnlen(ack->nonce, sizeof(ack->nonce)) != strlen(nonce) ||
      memcmp(ack->nonce, nonce, strlen(nonce)))
    return 2;
  return 0;
}
static int source_publish_ack(const struct source_admission *original, const char *nonce) {
  struct source_ready *ready = source_mapping(1);
  if (!ready)
    return 2;
  struct source_ack ack = {.original = *original};
  strcpy(ack.nonce, nonce);
  int failed = !source_completion_allows(ready, SOURCE_RECORD_ORIGINAL) ||
               source_live(original->consumer.token) || !source_owner_live() ||
               !access(HOOK_ROOT "/closed", F_OK) || source_window_update(SOURCE_WINDOW_ACK) ||
               protected_bytes(SOURCE_ACK, &ack, sizeof(ack)) ||
               protected_commit_bytes(HOOK_ROOT "/ack", nonce, strlen(nonce),
                                      &ready->completed[SOURCE_RECORD_ACK]);
  failed |= !source_completion_allows(ready, SOURCE_RECORD_ACK);
  if (failed)
    source_publication_failed();
  munmap(ready, sizeof(*ready));
  return failed ? 2 : 0;
}
static int source_status(int argc, char **argv, struct timeval boot) {
  if (argc != 2)
    return 2;
  if (!strcmp(argv[1], "--job-source-status")) {
    int ready =
        source_owner_live() && source_window_permits(0) && access(HOOK_ROOT "/closed", F_OK);
    printf("{\"subscriptionReady\":%s,\"tailComplete\":false}\n", ready ? "true" : "false");
    return ready ? 0 : 2;
  }
  if (strcmp(argv[1], "--job-source-ended"))
    return 2;
  struct source_terminal terminal;
  struct source_admission admitted;
  if (!source_committed(SOURCE_RECORD_ORIGINAL) || !source_committed(SOURCE_RECORD_TERMINAL) ||
      source_read(SOURCE_TERMINAL, &terminal, sizeof(terminal)) ||
      source_read(SOURCE_ADMISSION, &admitted, sizeof(admitted)) || source_health_failed(boot) ||
      !source_terminal_matches(&terminal, &admitted, boot, 1))
    return 2;
  puts("{\"originalConsumerExited\":true,\"uncertain\":false,\"tailComplete\":false}");
  return 0;
}
static int consume_ack(struct timeval boot, const char *nonce) {
  audit_token_t self;
  mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
  if (getuid() != 502 || strlen(nonce) != 64 ||
      task_info(mach_task_self(), TASK_AUDIT_TOKEN, (task_info_t)&self, &count) != KERN_SUCCESS ||
      count != TASK_AUDIT_TOKEN_COUNT)
    return 2;
  for (int remaining = 60; remaining > 0; remaining--) {
    if (!source_owner_live() || !source_window_permits(1) || !access(HOOK_ROOT "/closed", F_OK))
      return 1;
    struct source_ack ack;
    if (source_committed(SOURCE_RECORD_ACK)) {
      if (source_ack_record(boot, nonce, &ack) || !source_ack_matches(&ack, self, boot, nonce))
        return 1;
      return source_owner_live() && source_window_permits(1) && access(HOOK_ROOT "/closed", F_OK)
                 ? 0
                 : 1;
    }
    sleep(1);
  }
  return 1;
}
