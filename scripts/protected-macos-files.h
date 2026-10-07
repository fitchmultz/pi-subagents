// Descriptor-relative traversal: no intermediate CI-controlled symlink is followed.
#include <errno.h>
#include <fcntl.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
static inline int directory_at(int parent, const char *name) {
  int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  struct stat info;
  if (fd < 0)
    return -1;
  if (fstat(fd, &info) || !S_ISDIR(info.st_mode)) {
    close(fd);
    return -1;
  }
  return fd;
}
static inline int ci_directory(void) {
  int root = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  int users = directory_at(root, "Users"), ci = directory_at(users, "ci");
  close(root);
  close(users);
  return ci;
}
static inline int regular_path(const char *path) {
  if (*path != '/' || strlen(path) >= 4096)
    return -1;
  char buffer[4096];
  strcpy(buffer, path + 1);
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  char *component = buffer, *slash;
  while ((slash = strchr(component, '/'))) {
    *slash = 0;
    if (!*component || !strcmp(component, ".") || !strcmp(component, "..")) {
      close(fd);
      return -1;
    }
    int next = directory_at(fd, component);
    close(fd);
    fd = next;
    if (fd < 0)
      return -1;
    component = slash + 1;
  }
  int result = openat(fd, component, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  close(fd);
  return result;
}
// The existing root observer is the sole writer; readers see only complete 0444 files.
static inline int protected_bytes(const char *path, const void *value, size_t length) {
  if (*path != '/' || strlen(path) >= 4096) {
    errno = EINVAL;
    return 2;
  }
  char buffer[4096];
  strcpy(buffer, path + 1);
  int directory = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  char *name = buffer, *slash;
  while ((slash = strchr(name, '/'))) {
    *slash = 0;
    if (!*name || !strcmp(name, ".") || !strcmp(name, "..")) {
      close(directory);
      errno = EINVAL;
      return 2;
    }
    int next = directory_at(directory, name);
    int saved = errno;
    close(directory);
    directory = next;
    if (directory < 0) {
      errno = saved;
      return 2;
    }
    name = slash + 1;
  }
  struct stat info;
  if (!*name || !strcmp(name, ".") || !strcmp(name, "..") || fstat(directory, &info) ||
      info.st_uid != geteuid() || (info.st_mode & 0022)) {
    close(directory);
    errno = EACCES;
    return 2;
  }
  if (!fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW)) {
    close(directory);
    errno = EEXIST;
    return 1;
  }
  if (errno != ENOENT) {
    int saved = errno;
    close(directory);
    errno = saved;
    return 2;
  }
  char temporary[64];
  int fd = -1;
  for (int attempt = 0; attempt < 16; attempt++) {
    snprintf(temporary, sizeof(temporary), ".protected-%ld-%08x", (long)getpid(), arc4random());
    fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (fd >= 0 || errno != EEXIST)
      break;
  }
  int result = 2, saved = errno;
  if (fd >= 0) {
    size_t used = 0;
    while (used < length) {
      ssize_t written = write(fd, (const char *)value + used, length - used);
      if (written < 0 && errno == EINTR)
        continue;
      if (written <= 0) {
        if (!written)
          errno = EIO;
        break;
      }
      used += written;
    }
    if (used == length && !fchmod(fd, 0444) && !fsync(fd)) {
      // linkat publishes exclusively in the retained directory; never replace a replay.
      result = linkat(directory, temporary, directory, name, 0) ? (errno == EEXIST ? 1 : 2) : 0;
    }
    saved = errno;
    if (close(fd) && result != 2) {
      result = 2;
      saved = errno;
    }
    if (unlinkat(directory, temporary, 0) && result != 2) {
      result = 2;
      saved = errno;
    }
    // A published final remains on durability uncertainty; only our private temporary is removed.
    if (fsync(directory) && result != 2) {
      result = 2;
      saved = errno;
    }
  }
  if (close(directory) && result != 2) {
    result = 2;
    saved = errno;
  }
  errno = saved;
  return result;
}
// Visibility is not completion: release eligibility only after all owned persistence succeeds.
static inline int protected_commit_bytes(const char *path, const void *value, size_t length,
                                         _Atomic uint32_t *completed) {
  int result = protected_bytes(path, value, length);
  if (!result)
    atomic_store_explicit(completed, 1, memory_order_release);
  if (result == 1 && atomic_load_explicit(completed, memory_order_acquire) != 1)
    return 2; // An existing file cannot manufacture a lost producer's completion.
  return result;
}
static inline int protected_file(const char *path, const char *value) {
  return protected_bytes(path, value, strlen(value));
}
