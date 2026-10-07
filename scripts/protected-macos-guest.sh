#!/bin/bash
# Trusted guest bootstrap only. The host never executes this as root.
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
umask 077
disable_ssh_environment() {
  local configs config
  configs=$(/usr/bin/grep -rl '^AcceptEnv' /etc/ssh/sshd_config /etc/ssh/sshd_config.d) || [ "$?" = 1 ]
  while IFS= read -r config; do
    [ -n "$config" ] || continue
    /usr/bin/sed -i '' '/^AcceptEnv/d' "$config"
  done <<< "$configs"
}
if [ "$#" = 1 ] && { [ "$1" = -h ] || [ "$1" = --help ]; }; then
  printf '%s\n' \
    'Trusted guest-only bootstrap (never run as host root).' \
    'Usage: protected-macos-guest.sh blocked-file operator-public-key NAT-gateway' \
    'Send two new random passwords (admin, CI) on authenticated SSH stdin.' \
    'After guest CLT installation: protected-macos-guest.sh --install-observer SIGNED_SHA256' \
    'Example: sudo /bin/bash ./protected-macos-guest.sh blocked.txt operator.pub 192.168.64.1' \
    'Exit 0 completed; 1 failed boundary; 2 invalid usage.'
  exit 0
fi
[ "$(id -u)" = 0 ] || { echo 'Guest root required' >&2; exit 1; }
# Install only after CLT is present. This root-owned public-SDK observer never
# trusts a post-job CI-owned Node/Koffi toolchain, probe, or process listing.
if [ "$#" = 2 ] && [ "$1" = --install-observer ]; then
  script_directory=$(cd "$(dirname "$0")" && pwd)
  observer=$script_directory/protected-macos-observer-signed
  [[ "$2" =~ ^[a-f0-9]{64}$ ]] || exit 2
  [ "$(/usr/bin/shasum -a 256 "$observer" | /usr/bin/cut -d ' ' -f 1)" = "$2" ] || exit 1
  /usr/bin/codesign --verify --strict "$observer"
  signature=$(/usr/bin/codesign -dv "$observer" 2>&1)
  case "$signature" in *Signature=adhoc*|*TeamIdentifier=not\ set*) exit 1 ;; esac
  /usr/bin/codesign -d --entitlements - "$observer" > "$script_directory/observer-entitlements.plist"
  [ "$(/usr/bin/plutil -extract com.apple.developer.endpoint-security.client raw -o - "$script_directory/observer-entitlements.plist")" = true ] || exit 1
  printf 'Installing trusted root observer and immutable launch boundary\n'
  disable_ssh_environment
  /usr/bin/printf '\nPermitUserEnvironment no\nPermitUserRC no\n' >> /etc/ssh/sshd_config.d/000-protected-ci.conf
  /usr/sbin/sshd -t
  /usr/bin/install -o root -g wheel -m 600 "$script_directory/protected-macos-prejob.h" /Library/ProtectedCI/protected-macos-prejob.h
  /usr/bin/install -o root -g wheel -m 600 "$script_directory/protected-macos-arguments.h" /Library/ProtectedCI/protected-macos-arguments.h
  /usr/bin/install -o root -g wheel -m 600 "$script_directory/protected-macos-files.h" /Library/ProtectedCI/protected-macos-files.h
  /usr/bin/install -o root -g wheel -m 600 "$script_directory/protected-macos-runner-inputs.h" /Library/ProtectedCI/protected-macos-runner-inputs.h
  /usr/bin/install -o root -g wheel -m 600 "$script_directory/protected-macos-sockets.h" /Library/ProtectedCI/protected-macos-sockets.h
  for header in lifecycle lifecycle-es lifecycle-publication source-identity; do
    /usr/bin/install -o root -g wheel -m 600 "$script_directory/protected-macos-$header.h" "/Library/ProtectedCI/protected-macos-$header.h"
  done
  /usr/bin/install -o root -g wheel -m 600 "$script_directory/protected-macos-runner-integrity.tsv" /Library/ProtectedCI/runner-integrity.tsv
  /usr/bin/install -o root -g wheel -m 500 "$observer" /Library/ProtectedCI/quiescence
  for program in private-logs source-files; do
    /usr/bin/install -o root -g wheel -m 600 "$script_directory/protected-macos-$program.c" "/Library/ProtectedCI/$program.c"
    /usr/bin/clang -Wall -Werror -Wno-deprecated-declarations "/Library/ProtectedCI/$program.c" -o "/Library/ProtectedCI/$program"
    /usr/sbin/chown root:wheel "/Library/ProtectedCI/$program"
    /bin/chmod 500 "/Library/ProtectedCI/$program"
  done
  /usr/bin/install -d -o root -g wheel -m 755 /Library/ProtectedCIHooks
  /usr/bin/install -o root -g wheel -m 555 "$observer" /Library/ProtectedCIHooks/observer
  /usr/bin/install -o root -g wheel -m 444 "$script_directory/protected-macos-job-started.sh" /Library/ProtectedCIHooks/job-started.sh
  /usr/bin/install -o root -g wheel -m 444 "$script_directory/protected-macos-runner-launch.sh" /Library/ProtectedCIHooks/runner-launch.sh
  /bin/test ! -e /Users/ci/runner/.env
  /bin/test ! -e /Users/ci/runner/.path
  /bin/test ! -e /Users/ci/.ssh/environment
  /bin/test ! -e /Users/ci/.ssh/rc
  /usr/sbin/sshd -T | /usr/bin/grep -qx 'permituserenvironment no'
  if /usr/sbin/sshd -T | /usr/bin/grep -q '^acceptenv '; then
    echo 'SSH accepts inherited environment; native launch boundary rejected' >&2
    exit 1
  fi
  exit 0
fi
[ "$#" = 3 ] || { echo 'Usage: protected-macos-guest.sh blocked-file public-key gateway' >&2; exit 2; }
blocked=$1
public_key=$2
gateway=$3
# Passwords arrive over authenticated SSH stdin, not command arguments or logs.
IFS= read -r admin_password
IFS= read -r ci_password
[ ${#admin_password} -ge 32 ] && [ ${#ci_password} -ge 32 ]
dscl . -passwd /Users/admin admin "$admin_password"
rm -f /etc/kcpassword /etc/sudoers.d/admin-nopasswd
defaults delete /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true
/usr/sbin/visudo -c
/usr/libexec/PlistBuddy -c 'Print :autoLoginUser' /Library/Preferences/com.apple.loginwindow.plist >/dev/null 2>&1 && exit 1
[ ! -e /etc/kcpassword ]
# End the known admin GUI session before a standard account or CI exists.
launchctl bootout gui/501 2>/dev/null || true
chmod 700 /Users/admin
mkdir -p /Users/admin/.ssh
install -m 600 "$public_key" /Users/admin/.ssh/authorized_keys
chown -R admin:staff /Users/admin/.ssh
# Remove unnecessary image listeners; retain key-only SSH for trusted operations.
launchctl disable system/com.apple.screensharing
launchctl bootout system/com.apple.screensharing 2>/dev/null || true
launchctl disable system/com.apple.RemoteDesktop.agent
launchctl bootout system/com.apple.RemoteDesktop.agent 2>/dev/null || true
spctl --global-enable
mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/000-protected-ci.conf <<'SSH'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers admin ci
AllowTcpForwarding no
AllowAgentForwarding no
PermitTunnel no
X11Forwarding no
PermitUserEnvironment no
PermitUserRC no
SSH
# The stock include can accept LANG/LC_*. The protected launch accepts none.
disable_ssh_environment
/usr/sbin/sshd -t
# Public images may contain shared server private keys. Rotate them while this
# authenticated bootstrap connection remains open, then pin the new public key.
rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub
ssh-keygen -A
# A standard account, not a mapped or nominally immutable administrator.
if dscl . -read /Users/ci >/dev/null 2>&1; then exit 1; fi
dscl . -create /Users/ci
dscl . -create /Users/ci UniqueID 502
dscl . -create /Users/ci PrimaryGroupID 20
dscl . -create /Users/ci UserShell /bin/bash
dscl . -create /Users/ci NFSHomeDirectory /Users/ci
dscl . -create /Users/ci RealName 'Protected one-job CI'
dscl . -passwd /Users/ci "$ci_password"
unset admin_password ci_password
mkdir -p /Users/ci/.ssh /opt/homebrew
install -m 600 "$public_key" /Users/ci/.ssh/authorized_keys
chown -R ci:staff /Users/ci /opt/homebrew
chmod 700 /Users/ci /Users/ci/.ssh
dseditgroup -o edit -a ci -t user com.apple.access_ssh
if dsmemberutil checkmembership -U ci -G admin | grep -q 'is a member'; then exit 1; fi
# No root service runs workspace code, brew, Node, or any CI-controlled PATH.
mkdir -p /Library/ProtectedCI
chmod 700 /Library/ProtectedCI
install -m 600 "$blocked" /Library/ProtectedCI/blocked.txt
cat > /Library/ProtectedCI/pf.conf <<PF
set block-policy return
pass quick on lo0 all
block drop quick inet6 all
table <desktop> persist file "/Library/ProtectedCI/blocked.txt"
block all
pass in quick proto tcp from $gateway to any port 22 flags S/SA keep state
pass out quick inet proto udp from any port 68 to { $gateway, 255.255.255.255 } port 67 no state
pass in quick inet proto udp from $gateway port 67 to any port 68 no state
block return quick inet to <desktop>
pass out quick inet proto { udp, tcp } to { 1.1.1.1, 9.9.9.9 } port 53 keep state
pass out quick inet proto tcp to any port { 80, 443 } flags S/SA keep state
PF
cat > /Library/ProtectedCI/load-pf.sh <<'LOAD'
#!/bin/bash
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
/sbin/pfctl -nf /Library/ProtectedCI/pf.conf
/sbin/pfctl -f /Library/ProtectedCI/pf.conf
/sbin/pfctl -F states
if ! /sbin/pfctl -s info 2>/dev/null | /usr/bin/grep -q 'Status: Enabled'; then
  /sbin/pfctl -e
fi
LOAD
chmod 700 /Library/ProtectedCI/load-pf.sh
cat > /Library/LaunchDaemons/com.fitchmultz.protected-ci-pf.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.fitchmultz.protected-ci-pf</string>
<key>ProgramArguments</key><array><string>/Library/ProtectedCI/load-pf.sh</string></array>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>/Library/ProtectedCI/pf.log</string>
<key>StandardErrorPath</key><string>/Library/ProtectedCI/pf.err</string>
</dict></plist>
PLIST
chown -R root:wheel /Library/ProtectedCI /Library/LaunchDaemons/com.fitchmultz.protected-ci-pf.plist
chmod 600 /Library/LaunchDaemons/com.fitchmultz.protected-ci-pf.plist
/usr/bin/plutil -lint /Library/LaunchDaemons/com.fitchmultz.protected-ci-pf.plist
# The caller closes bootstrap SSH, then activates PF through a fresh owner channel.
/usr/sbin/networksetup -setdnsservers Ethernet 1.1.1.1 9.9.9.9
printf 'Guest privilege/bootstrap preparation complete; PF activation still required.\n'
cat /etc/ssh/ssh_host_ed25519_key.pub
