// Public KERN_PROCARGS2 argv decoding; executable padding is not argument data.
static int arguments(int pid, char *buffer, size_t capacity, char **values, int *count) {
  int mib[] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t used = capacity;
  if (sysctl(mib, 3, buffer, &used, NULL, 0) || used < sizeof(int))
    return 2;
  memcpy(count, buffer, sizeof(int));
  if (*count < 1 || *count > 64)
    return 2;
  char *p = buffer + sizeof(int), *end = buffer + used;
  size_t length = strnlen(p, end - p);
  if (p + length >= end)
    return 2;
  struct observed observed;
  if (identity(pid, &observed))
    return 2;
  size_t pointer = observed.info.pbi_flags & PROC_FLAG_LP64 ? 8 : 4;
  size_t saved = length + 1 + strlen("executable_path=");
  size_t start =
      sizeof(int) + (saved + pointer - 1) / pointer * pointer - strlen("executable_path=");
  if (start >= used || buffer + start < p + length + 1)
    return 2;
  for (char *padding = p + length + 1; padding < buffer + start; padding++)
    if (*padding)
      return 2;
  p = buffer + start;
  for (int i = 0; i < *count; i++) {
    if (p >= end)
      return 2;
    values[i] = p;
    length = strnlen(p, end - p);
    if (p + length >= end)
      return 2;
    p += length + 1;
  }
  return 0;
}
