// Root-native file integrity for the complete reviewed official runner inputs.
#include <CommonCrypto/CommonDigest.h>
static int hash_file(const char *path, char result[65]) {
  int fd = regular_path(path);
  struct stat before, after;
  if (fd < 0 || fstat(fd, &before) || !S_ISREG(before.st_mode) || before.st_size > 104857600)
    return 2;
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  unsigned char bytes[65536], digest[CC_SHA256_DIGEST_LENGTH];
  ssize_t used;
  while ((used = read(fd, bytes, sizeof(bytes))) > 0)
    CC_SHA256_Update(&context, bytes, (CC_LONG)used);
  int failed = used < 0 || fstat(fd, &after) || before.st_dev != after.st_dev ||
               before.st_ino != after.st_ino || before.st_size != after.st_size ||
               before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec ||
               before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec;
  close(fd);
  if (failed)
    return 2;
  CC_SHA256_Final(digest, &context);
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++)
    sprintf(result + i * 2, "%02x", digest[i]);
  return 0;
}
static int reviewed_inputs(void) {
  char actual[65];
  if (hash_file("/Library/ProtectedCI/runner-integrity.tsv", actual) ||
      strcmp(actual, "815f038d30beb579a5e2873170c14ed27f55a4815b48c6ca16b1c9b9ef4afa43"))
    return 2;
  int fd = regular_path("/Library/ProtectedCI/runner-integrity.tsv");
  struct stat st;
  if (fd < 0 || fstat(fd, &st) || st.st_uid || st.st_mode & 0022)
    return 2;
  FILE *manifest = fdopen(fd, "r");
  if (!manifest) {
    close(fd);
    return 2;
  }
  char line[4096];
  int count = 0, result = 0;
  if (!fgets(line, sizeof(line), manifest))
    result = 2;
  while (!result && fgets(line, sizeof(line), manifest)) {
    char *path = strchr(line, '\t'), *end = strchr(line, '\n');
    if (!path || !end || path - line != 64 || strncmp(path + 1, "bin/", 4)) {
      result = 2;
      break;
    }
    *path++ = 0;
    *end = 0;
    char full[4096];
    snprintf(full, sizeof(full), "/Users/ci/runner/%s", path);
    if (hash_file(full, actual) || strcmp(actual, line)) {
      result = 1;
      break;
    }
    count++;
  }
  if (ferror(manifest) || (!result && count != 266))
    result = 2;
  fclose(manifest);
  return result;
}
