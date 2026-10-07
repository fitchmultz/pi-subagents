// Root reads original extension checkout bytes/modes; never CI .git or executables.
#include "protected-macos-files.h"
#include <CommonCrypto/CommonDigest.h>
#include <stdio.h>
#include <stdlib.h>
static int workspace(void) {
  int fd = ci_directory();
  const char *parts[] = {"runner", "_work", "pi-subagents", "pi-subagents", "extension"};
  for (size_t i = 0; i < sizeof(parts) / sizeof(parts[0]); i++) {
    int next = directory_at(fd, parts[i]);
    close(fd);
    fd = next;
    if (fd < 0)
      return -1;
  }
  return fd;
}
static int parent_directory(int root, char *path, char **leaf) {
  int fd = dup(root);
  char *component = path, *slash;
  while ((slash = strchr(component, '/'))) {
    *slash = 0;
    if (!*component || !strcmp(component, ".") || !strcmp(component, "..") ||
        !strcmp(component, ".git")) {
      close(fd);
      return -1;
    }
    int next = directory_at(fd, component);
    close(fd);
    fd = next;
    component = slash + 1;
    if (fd < 0)
      return -1;
  }
  if (!*component || !strcmp(component, ".") || !strcmp(component, "..") ||
      !strcmp(component, ".git")) {
    close(fd);
    return -1;
  }
  *leaf = component;
  return fd;
}
static int blob(int parent, const char *name, const char *mode, char sha[41]) {
  struct stat before, after;
  if (fstatat(parent, name, &before, AT_SYMLINK_NOFOLLOW) || before.st_size < 0 ||
      before.st_size > 268435456)
    return 2;
  int link = !strcmp(mode, "120000");
  if (link ? !S_ISLNK(before.st_mode) : !S_ISREG(before.st_mode))
    return 1;
  if (!link && strcmp(mode, before.st_mode & 0111 ? "100755" : "100644"))
    return 1;
  CC_SHA1_CTX context;
  CC_SHA1_Init(&context);
  char header[64];
  int length = snprintf(header, sizeof(header), "blob %lld", before.st_size);
  CC_SHA1_Update(&context, header, length + 1);
  if (link) {
    char data[4096];
    ssize_t used = readlinkat(parent, name, data, sizeof(data));
    if (used != before.st_size || used >= sizeof(data))
      return 2;
    CC_SHA1_Update(&context, data, (CC_LONG)used);
  } else {
    int fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    struct stat descriptor;
    if (fd < 0 || fstat(fd, &descriptor) || descriptor.st_ino != before.st_ino ||
        descriptor.st_dev != before.st_dev)
      return 2;
    unsigned char data[65536];
    ssize_t used;
    off_t total = 0;
    while ((used = read(fd, data, sizeof(data))) > 0) {
      total += used;
      CC_SHA1_Update(&context, data, (CC_LONG)used);
    }
    close(fd);
    if (used < 0 || total != before.st_size)
      return 2;
  }
  if (fstatat(parent, name, &after, AT_SYMLINK_NOFOLLOW) || before.st_ino != after.st_ino ||
      before.st_dev != after.st_dev || before.st_size != after.st_size ||
      before.st_mode != after.st_mode || before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec ||
      before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec)
    return 2;
  unsigned char digest[CC_SHA1_DIGEST_LENGTH];
  CC_SHA1_Final(digest, &context);
  for (int i = 0; i < CC_SHA1_DIGEST_LENGTH; i++)
    sprintf(sha + i * 2, "%02x", digest[i]);
  return 0;
}
int main(void) {
  if (getuid() != 0)
    return 2;
  int root = workspace();
  if (root < 0)
    return 2;
  char line[8192];
  size_t count = 0, bytes = 0;
  while (fgets(line, sizeof(line), stdin)) {
    size_t n = strlen(line);
    bytes += n;
    if (!n || line[n - 1] != '\n' || bytes > 1048576 || ++count > 20000)
      return 2;
    line[n - 1] = 0;
    char *mode = line, *sha = strchr(line, '\t');
    if (!sha)
      return 2;
    *sha++ = 0;
    char *path = strchr(sha, '\t');
    if (!path)
      return 2;
    *path++ = 0;
    if (strlen(sha) != 40 || strspn(sha, "0123456789abcdef") != 40 ||
        (strcmp(mode, "100644") && strcmp(mode, "100755") && strcmp(mode, "120000")))
      return 2;
    char *leaf;
    int parent = parent_directory(root, path, &leaf);
    if (parent < 0)
      return 2;
    char actual[41];
    int result = blob(parent, leaf, mode, actual);
    close(parent);
    if (result || strcmp(actual, sha)) {
      printf("{\"consistent\":false,\"fileIndex\":%zu,\"uncertain\":%s}\n", count,
             result == 2 ? "true" : "false");
      return result == 2 ? 2 : 1;
    }
  }
  if (ferror(stdin) || !count)
    return 2;
  close(root);
  printf("{\"consistent\":true,\"files\":%zu,\"manifestBytes\":%zu}\n", count, bytes);
  return 0;
}
