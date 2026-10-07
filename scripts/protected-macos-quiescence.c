// Trusted guest-root public-SDK observer. No CI executable or filename grants admission.
#include <errno.h>
#include <grp.h>
#include <libproc.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <unistd.h>
#define CAPACITY 262144
struct cut {
  int pid;
  uid_t uid;
  pid_t sid;
  unsigned long long seconds, microseconds;
};
struct observed {
  struct cut identity;
  struct proc_bsdinfo info;
  char path[PROC_PIDPATHINFO_MAXSIZE];
};
static void text(const char *value) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    if (*p == '"' || *p == '\\')
      printf("\\%c", *p);
    else if (*p < 32)
      printf("\\u%04x", *p);
    else
      putchar(*p);
  }
  putchar('"');
}
static int equal(struct cut a, struct cut b) {
  return a.pid == b.pid && a.uid == b.uid && a.sid == b.sid && a.seconds == b.seconds &&
         a.microseconds == b.microseconds;
}
static int identity(int pid, struct observed *entry) {
  struct proc_bsdinfo b;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 1, &b, sizeof(b)) != sizeof(b))
    return 2;
  if (b.pbi_pid != pid || b.pbi_uid != 502)
    return 2;
  pid_t sid = getsid(pid);
  if (sid < 0)
    return 2;
  entry->identity = (struct cut){pid, b.pbi_uid, sid, b.pbi_start_tvsec, b.pbi_start_tvusec};
  entry->info = b;
  entry->path[0] = 0;
  // Name/path are diagnostics only; failure never grants a lifetime exemption.
  proc_pidpath(pid, entry->path, sizeof(entry->path));
  return 0;
}
static void print_entry(struct observed entry, int known) {
  struct proc_bsdinfo b = entry.info;
  printf("{\"pid\":%u,\"uid\":%u,\"sid\":%d,\"pgid\":%u,\"ppid\":%u,\"birthSeconds\":%llu,"
         "\"birthMicroseconds\":%llu,\"status\":%u,\"preJob\":%s,\"comm\":",
         b.pbi_pid, b.pbi_uid, entry.identity.sid, b.pbi_pgid, b.pbi_ppid, b.pbi_start_tvsec,
         b.pbi_start_tvusec, b.pbi_status, known ? "true" : "false");
  text(b.pbi_comm);
  printf(",\"path\":");
  text(entry.path);
  putchar('}');
}
static int order(const void *left, const void *right) {
  const struct observed *a = left, *b = right;
  return (a->identity.pid > b->identity.pid) - (a->identity.pid < b->identity.pid);
}
static int collect(struct observed *entries, size_t *count) {
  int *pids = calloc(CAPACITY, sizeof(int));
  if (!pids)
    return 2;
  int used = proc_listpids(PROC_UID_ONLY, 502, pids, CAPACITY * sizeof(int));
  if (used < 0 || used >= CAPACITY * sizeof(int) || used % sizeof(int)) {
    free(pids);
    return 2;
  }
  *count = 0;
  for (int i = 0; i < used / sizeof(int); i++) {
    if (pids[i] <= 0)
      continue;
    if (identity(pids[i], &entries[*count])) {
      printf("{\"uncertain\":true,\"enumeratedPid\":%d,\"reason\":\"native identity disappeared or "
             "changed\"}\n",
             pids[i]);
      free(pids);
      return 2;
    }
    (*count)++;
  }
  free(pids);
  qsort(entries, *count, sizeof(*entries), order);
  return 0;
}
static int boot_time(struct timeval *boot) {
  size_t size = sizeof(*boot);
  return sysctlbyname("kern.boottime", boot, &size, NULL, 0) || size != sizeof(*boot);
}
static int write_cut(const char *path, struct timeval boot, struct cut *entries, size_t count) {
  FILE *file = fopen(path, "wb");
  if (!file)
    return 2;
  int failed = fwrite(&boot, sizeof(boot), 1, file) != 1 ||
               fwrite(&count, sizeof(count), 1, file) != 1 ||
               fwrite(entries, sizeof(*entries), count, file) != count;
  if (fclose(file))
    failed = 1;
  return failed ? 2 : 0;
}
static int read_cut(const char *path, struct timeval boot, struct cut *entries, size_t *count) {
  FILE *file = fopen(path, "rb");
  struct timeval recorded = {0};
  size_t actual = 0;
  if (!file)
    return 2;
  int failed = fread(&recorded, sizeof(recorded), 1, file) != 1 ||
               fread(&actual, sizeof(actual), 1, file) != 1 || actual > *count ||
               fread(entries, sizeof(*entries), actual, file) != actual || fgetc(file) != EOF;
  fclose(file);
  if (recorded.tv_sec != boot.tv_sec || recorded.tv_usec != boot.tv_usec)
    failed = 1;
  if (!failed)
    *count = actual;
  return failed ? 2 : 0;
}
static int listener(int argc, char **argv, struct timeval boot) {
  struct observed entry;
  struct cut saved;
  size_t count = 1;
  if (argc == 2 && !strcmp(argv[1], "--listener-absent")) {
    if (read_cut("/Library/ProtectedCI/listener.bin", boot, &saved, &count) || count != 1)
      return 2;
    if (!identity(saved.pid, &entry)) {
      print_entry(entry, 0);
      putchar('\n');
      return equal(saved, entry.identity) ? 1 : 2;
    }
    if (kill(saved.pid, 0) != -1 || errno != ESRCH)
      return 2;
    puts("{\"listenerAbsent\":true,\"errno\":\"ESRCH\"}");
    return 0;
  }
  if (argc != 3 || strcmp(argv[1], "--listener-admit"))
    return 2;
  char *end;
  long pid = strtol(argv[2], &end, 10);
  if (*end || pid <= 0 || pid > 2147483647 || identity((int)pid, &entry))
    return 2;
  struct observed revalidated;
  if (identity((int)pid, &revalidated) || !equal(entry.identity, revalidated.identity))
    return 2;
  if (write_cut("/Library/ProtectedCI/listener.bin", boot, &entry.identity, 1))
    return 2;
  print_entry(entry, 0);
  putchar('\n');
  return 0;
}
#include "protected-macos-lifecycle-es.h"
int main(int argc, char **argv) {
  umask(077);
  struct timeval boot;
  if (boot_time(&boot))
    return 2;
  if (argc == 3 && !strcmp(argv[1], "--job-consume"))
    return consume_ack(boot, argv[2]);
  if (getuid() != 0)
    return 2;
  if (argc == 2 && !strcmp(argv[1], "--job-observe"))
    return observe_job(boot);
  if (argc > 1 && !strncmp(argv[1], "--job-source-", 13))
    return source_status(argc, argv, boot);
  if (argc > 1 && !strncmp(argv[1], "--job-", 6))
    return prejob(argc, argv, boot);
  if (argc > 1 && !strncmp(argv[1], "--listener-", 11))
    return listener(argc, argv, boot);
  int snapshot = argc == 2 && !strcmp(argv[1], "--snapshot");
  int empty = argc == 2 && !strcmp(argv[1], "--empty");
  if (argc != 1 && !snapshot && !empty)
    return 2;
  struct observed *first = calloc(CAPACITY, sizeof(*first)),
                  *second = calloc(CAPACITY, sizeof(*second));
  struct cut *baseline = calloc(CAPACITY, sizeof(*baseline));
  size_t count = snapshot || empty ? 0 : CAPACITY, a = 0, b = 0;
  if (!first || !second || !baseline)
    return 2;
  if (!snapshot && !empty && read_cut("/Library/ProtectedCI/baseline.bin", boot, baseline, &count))
    return 2;
  if (collect(first, &a))
    return 2;
  // Renew enumeration and all PID/birth/UID/SID observations. Churn is uncertainty.
  if (collect(second, &b))
    return 2;
  if (a != b) {
    puts("{\"uncertain\":true,\"reason\":\"native enumeration changed\"}");
    return 2;
  }
  for (size_t i = 0; i < a; i++) {
    if (!equal(first[i].identity, second[i].identity)) {
      puts("{\"uncertain\":true,\"reason\":\"native incarnation changed\"}");
      return 2;
    }
  }
  int remaining = 0;
  printf("{\"uid\":502,\"bootSeconds\":%ld,\"bootMicroseconds\":%d,\"stableEnumerations\":2,"
         "\"identities\":[",
         boot.tv_sec, boot.tv_usec);
  for (size_t i = 0; i < b; i++) {
    int known = 0;
    for (size_t j = 0; j < count; j++)
      if (equal(baseline[j], second[i].identity))
        known = 1;
    if (!known)
      remaining++;
    if (i)
      putchar(',');
    print_entry(second[i], known);
    if (snapshot)
      baseline[i] = second[i].identity;
  }
  if (snapshot) {
    if (write_cut("/Library/ProtectedCI/baseline.bin", boot, baseline, b))
      return 2;
    remaining = 0;
  }
  printf("],\"remaining\":%d,\"uncertain\":false}\n", remaining);
  free(first);
  free(second);
  free(baseline);
  return remaining ? 1 : 0;
}
