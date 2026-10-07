// Trusted root file reader: CI log paths/links/content are never host commands.
#include "protected-macos-files.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#define FILE_LIMIT 524288
#define TOTAL_LIMIT 2097152
int main(void) {
  if (getuid() != 0)
    return 2;
  int ci = ci_directory(), runner = directory_at(ci, "runner");
  int fd = directory_at(runner, "_diag");
  close(ci);
  close(runner);
  if (fd < 0)
    return 2;
  DIR *directory = fdopendir(fd);
  if (!directory) {
    close(fd);
    return 2;
  }
  struct dirent *entry;
  size_t total = 0;
  int files = 0;
  unsigned char *buffer = malloc(FILE_LIMIT);
  if (!buffer)
    return 2;
  printf("{\"perFileLimit\":%d,\"totalLimit\":%d,\"files\":[", FILE_LIMIT, TOTAL_LIMIT);
  while ((entry = readdir(directory))) {
    const char *name = entry->d_name;
    size_t length = strlen(name);
    if (name[0] == '.' || length < 5 || strcmp(name + length - 4, ".log"))
      continue;
    if (length >= 200 ||
        strspn(name, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-") != length)
      return 2;
    if (files >= 32 || total >= TOTAL_LIMIT)
      break;
    int input = openat(fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    struct stat info;
    if (input < 0 || fstat(input, &info) || !S_ISREG(info.st_mode) || info.st_uid != 502)
      return 2;
    size_t cap = FILE_LIMIT < TOTAL_LIMIT - total ? FILE_LIMIT : TOTAL_LIMIT - total;
    size_t used = 0;
    while (used < cap) {
      ssize_t bytes = read(input, buffer + used, cap - used);
      if (bytes < 0 && errno == EINTR)
        continue;
      if (bytes < 0)
        return 2;
      if (!bytes)
        break;
      used += bytes;
    }
    close(input);
    if (files++)
      putchar(',');
    printf("{\"name\":\"%s\",\"truncated\":%s,\"hex\":\"", name,
           info.st_size > used ? "true" : "false");
    for (size_t i = 0; i < used; i++)
      printf("%02x", buffer[i]);
    printf("\"}");
    total += used;
  }
  printf("],\"totalBytes\":%zu}\n", total);
  free(buffer);
  closedir(directory);
  return 0;
}
