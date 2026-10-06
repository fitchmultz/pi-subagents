/* Independent execve fixture: publish actual inherited ownership before changing
 * argv/env, wait for the test's FD acknowledgement, then exec exact byte strings.
 * The hold form blocks in a FIFO even with a single empty argv or empty env. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>

static int publish_receipt(const char *path, const char *owner) {
  size_t size = strlen(path) + sizeof(".tmp");
  char *temp = malloc(size);
  if (!temp) return 1;
  snprintf(temp, size, "%s.tmp", path);
  FILE *receipt = fopen(temp, "w");
  if (!receipt) { free(temp); return 1; }
  int written = fprintf(receipt, "{\"pid\":%d,\"uid\":%d,\"sid\":%d,\"owners\":\"%s\"}",
                        getpid(), getuid(), getsid(0), owner ? owner : "");
  int closed = fclose(receipt);
  int result = written < 0 || closed || rename(temp, path) ? 2 : 0;
  free(temp);
  return result;
}

int main(int argc, char **argv) {
  const char *hold = getenv("FIXTURE_HOLD");
  if (!hold && argc >= 3 && !strcmp(argv[argc - 2], "--hold")) hold = argv[argc - 1];
  if (hold) {
    const char *ready = getenv("FIXTURE_READY");
    if (ready) {
      int result = publish_receipt(ready, getenv("PI_COMPAT_PROCESS_OWNERS"));
      if (result) return 20 + result;
    }
    int fd = open(hold, O_RDONLY);
    if (fd < 0) return 20;
    char value;
    while (read(fd, &value, 1) > 0) {}
    close(fd);
    return 0;
  }
  if (argc < 6) return 2;
  int nargs = atoi(argv[3]);
  if (nargs < 1 || 4 + nargs >= argc) return 3;
  int envAt = 4 + nargs, nenv = atoi(argv[envAt]);
  if (nenv < 0 || envAt + 1 + nenv != argc) return 4;
  const char *owner = getenv("PI_COMPAT_PROCESS_OWNERS");
  if (!owner) return 5;
  char **args = calloc((size_t)nargs + 1, sizeof(char *));
  char **env = calloc((size_t)nenv + 1, sizeof(char *));
  if (!args || !env) return 6;
  for (int i = 0; i < nargs; i++) args[i] = argv[4 + i];
  for (int i = 0; i < nenv; i++) {
    const char *entry = argv[envAt + 1 + i];
    if (!strcmp(entry, "@OWNER")) {
      size_t size = strlen(owner) + sizeof("PI_COMPAT_PROCESS_OWNERS=");
      env[i] = malloc(size);
      if (!env[i]) return 7;
      snprintf(env[i], size, "PI_COMPAT_PROCESS_OWNERS=%s", owner);
    } else env[i] = (char *)entry;
  }
  int result = publish_receipt(argv[1], owner);
  if (result) return 7 + result;
  char value;
  if (read(3, &value, 1) != 1) return 10;
  close(3);
  execve(argv[2], args, env);
  return 11;
}
