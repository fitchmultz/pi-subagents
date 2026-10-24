#!/bin/bash
set -euo pipefail
root=$1
shift
mount --make-rprivate /
mkdir -p "$root"/{usr,etc,dev/shm,proc,tmp,root,workspace/issue-249}
chmod 1777 "$root/tmp"
mount --bind /usr "$root/usr"
mount -o remount,bind,ro "$root/usr"
for component in bin sbin lib lib64; do
  ln -s "usr/$component" "$root/$component"
done
for file in passwd group nsswitch.conf ld.so.cache hosts; do
  cp "/etc/$file" "$root/etc/$file"
done
mknod -m 666 "$root/dev/null" c 1 3
mknod -m 666 "$root/dev/zero" c 1 5
mount -t proc proc "$root/proc"
mount -t tmpfs -o mode=1777,nosuid,nodev,size=16m tmpfs "$root/dev/shm"
mount --bind /workspace/issue-249 "$root/workspace/issue-249"
mount -o remount,bind,ro "$root/workspace/issue-249"
chroot "$root" /bin/bash -c 'cd /workspace/issue-249; exec /usr/local/bin/node "$@"' native-fixture "$@"
