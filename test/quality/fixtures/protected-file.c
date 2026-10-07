// Local filesystem publication boundary; directory failure below is explicitly injected.
#include <fcntl.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>
static int fixture_fsync(int fd);
#define fsync fixture_fsync
#include "../../../scripts/protected-macos-files.h"
#undef fsync

static _Atomic uint32_t completed;
static int directories, pause_at, fail_directory;
static int fixture_fsync(int fd) {
  struct stat info;
  if (fstat(fd, &info))
    return -1;
  if (S_ISDIR(info.st_mode) && ++directories == pause_at) {
    printf("{\"phase\":\"before-directory-fsync\",\"completed\":%u,\"directories\":%d}\n",
           atomic_load(&completed), directories);
    fflush(stdout);
    char release[3];
    if (read(STDIN_FILENO, release, sizeof(release)) != sizeof(release) ||
        memcmp(release, "go\n", sizeof(release))) {
      errno = ECANCELED;
      return -1;
    }
    if (fail_directory) {
      errno = EIO;
      return -1;
    }
  }
  return fsync(fd);
}
static int commit(const char *path, const char *value, const char *mode, int *replay) {
  int ack = !strncmp(mode, "ack-", 4);
  pause_at = ack ? 2 : 1;
  fail_directory = strstr(mode, "fail") != NULL;
  char marker[4096];
  if (snprintf(marker, sizeof(marker), "%s.marker", path) >= sizeof(marker))
    return 2;
  const char *final = ack ? marker : path, *content = ack ? "ack-marker\n" : value;
  int result = ack ? protected_bytes(path, value, strlen(value)) : 0;
  if (!result)
    result = protected_commit_bytes(final, content, strlen(content), &completed);
  int saved = errno;
  *replay = protected_commit_bytes(final, content, strlen(content), &completed);
  errno = saved;
  return result;
}
int main(int argc, char **argv) {
  if (argc != 4)
    return 1;
  umask(077);
  if (!strcmp(argv[3], "short-write")) {
    struct rlimit limit = {4, 4};
    if (signal(SIGXFSZ, SIG_IGN) == SIG_ERR || setrlimit(RLIMIT_FSIZE, &limit))
      return 1;
  }
  const unsigned char record[] = {0, 1, 255, 0, 42, 10};
  int result, replay = -1;
  if (!strncmp(argv[3], "commit", 6) || !strncmp(argv[3], "ack-", 4))
    result = commit(argv[1], argv[2], argv[3], &replay);
  else
    result = !strcmp(argv[3], "binary") ? protected_bytes(argv[1], record, sizeof(record))
                                        : protected_file(argv[1], argv[2]);
  printf("{\"result\":%d,\"errno\":%d,\"completed\":%u,\"replay\":%d}\n", result, errno,
         atomic_load(&completed), replay);
  return 0;
}
