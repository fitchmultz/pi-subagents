#!/bin/bash
set -euo pipefail
root=$1
binary=$2
shift 2
mount --make-rprivate /
mount --bind "$root" "$root"
mkdir -p "$root"/{usr,etc,dev/shm,proc,tmp,root,workspace/issue-249}
chmod 1777 "$root/tmp"
mount --bind /usr "$root/usr"
mount -o remount,bind,ro "$root/usr"
mount --bind "$binary" "$root/usr/local/bin/node"
mount -o remount,bind,ro "$root/usr/local/bin/node"
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
