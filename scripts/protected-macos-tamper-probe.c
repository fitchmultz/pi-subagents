// Ordinary CI-UID qualification control. Never installed or executed as root.
#include <errno.h>
#include <mach/mach.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ptrace.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (getuid() != 502 || argc != 2)
    return 2;
  char *end;
  long pid = strtol(argv[1], &end, 10);
  if (*end || pid <= 0 || pid > 2147483647)
    return 2;
  mach_port_t port = MACH_PORT_NULL;
  kern_return_t task = task_for_pid(mach_task_self(), (int)pid, &port);
  if (port != MACH_PORT_NULL)
    mach_port_deallocate(mach_task_self(), port);
  errno = 0;
  int attached = ptrace(PT_ATTACHEXC, (int)pid, 0, 0), failure = errno, detached = 0;
  if (attached == 0)
    detached = ptrace(PT_DETACH, (int)pid, (caddr_t)1, 0);
  printf("{\"uid\":%u,\"pid\":%ld,\"taskReturn\":%d,\"taskPortGranted\":%s,\"ptraceResult\":%d,"
         "\"ptraceErrno\":%d,\"detachResult\":%d}\n",
         getuid(), pid, task, task == KERN_SUCCESS ? "true" : "false", attached, failure, detached);
  return attached == 0 && detached != 0 ? 1 : 0;
}
