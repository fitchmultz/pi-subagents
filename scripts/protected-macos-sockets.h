// Coherent native FD/socket observation shared by the guard and diagnostics.
#include <sys/socket.h>
static struct {
  int fd, family, kind, tcp_state, options;
} listening;
static int fd_order(const void *a, const void *b) {
  const struct proc_fdinfo *x = a, *y = b;
  return (x->proc_fd > y->proc_fd) - (x->proc_fd < y->proc_fd);
}
static int fd_list(int pid, struct proc_fdinfo **entries, int *used) {
  int size = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
  if (size <= 0 || size > 1048576 || size % sizeof(struct proc_fdinfo))
    return 2;
  int capacity = size + 128 * sizeof(struct proc_fdinfo);
  *entries = calloc(1, capacity);
  if (!*entries)
    return 2;
  *used = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, *entries, capacity);
  if (*used < 0 || *used >= capacity || *used % sizeof(struct proc_fdinfo))
    return 2;
  qsort(*entries, *used / sizeof(struct proc_fdinfo), sizeof(struct proc_fdinfo), fd_order);
  return 0;
}
static int sockets(int pid, struct proc_fdinfo *entries, int used, uint64_t *handles) {
  for (int i = 0; i < used / sizeof(*entries); i++) {
    if (entries[i].proc_fdtype != PROX_FDTYPE_SOCKET)
      continue;
    struct socket_fdinfo socket;
    if (proc_pidfdinfo(pid, entries[i].proc_fd, PROC_PIDFDSOCKETINFO, &socket, sizeof(socket)) !=
        sizeof(socket))
      return 2;
    struct socket_info s = socket.psi;
    handles[i] = s.soi_so;
    if ((s.soi_options & SO_ACCEPTCONN) ||
        (s.soi_kind == SOCKINFO_TCP && s.soi_proto.pri_tcp.tcpsi_state == TSI_S_LISTEN)) {
      listening.fd = entries[i].proc_fd;
      listening.family = s.soi_family;
      listening.kind = s.soi_kind;
      listening.tcp_state = s.soi_kind == SOCKINFO_TCP ? s.soi_proto.pri_tcp.tcpsi_state : -1;
      listening.options = s.soi_options;
      return 1;
    }
    if (s.soi_kind != SOCKINFO_TCP && s.soi_kind != SOCKINFO_UN && s.soi_kind != SOCKINFO_IN)
      return 2;
  }
  return 0;
}
static int no_listeners(struct observed entry) {
  struct proc_fdinfo *a = NULL, *b = NULL;
  int x = 0, y = 0;
  if (fd_list(entry.identity.pid, &a, &x)) {
    free(a);
    return 2;
  }
  uint64_t *first = calloc(x + 1, sizeof(uint64_t));
  int result = first ? sockets(entry.identity.pid, a, x, first) : 2;
  if (!result && fd_list(entry.identity.pid, &b, &y))
    result = 2;
  uint64_t *second = calloc(y + 1, sizeof(uint64_t));
  if (!result)
    result = second ? sockets(entry.identity.pid, b, y, second) : 2;
  if (!result &&
      (x != y || memcmp(a, b, x) || memcmp(first, second, x / sizeof(*a) * sizeof(*first))))
    result = 2;
  struct observed after;
  if (identity(entry.identity.pid, &after) || !equal(entry.identity, after.identity))
    result = 2;
  free(a);
  free(b);
  free(first);
  free(second);
  return result;
}
