#!/usr/bin/env bash
# Create-only synthetic investigator login home. This never invokes Codex or reads credentials.
set -euo pipefail
umask 077

check_secure_dir() {
  local dir=$1 owner=$2 mode
  if [ -L "$dir" ] || [ ! -d "$dir" ] ||
     [ "$(realpath -e -- "$dir")" != "$dir" ] ||
     [ "$(stat -c %u -- "$dir")" != "$owner" ]; then
    echo 'UNSAFE_PARENT' >&2; return 3
  fi
  mode=$(stat -c %a -- "$dir")
  if [[ ! $mode =~ ^[0-7]{3,4}$ ]] || (( (8#$mode & 0022) != 0 )); then
    echo 'UNSAFE_PARENT' >&2; return 3
  fi
}

check_secure_entry() {
  local entry=$1 owner=$2 mode
  if [ ! -f "$entry" ] || [ -L "$entry" ] ||
     [ "$(realpath -e -- "$entry")" != "$entry" ] ||
     [ "$(stat -c %u -- "$entry")" != "$owner" ]; then
    echo 'INVALID_INSTALL' >&2; return 3
  fi
  mode=$(stat -c %a -- "$entry")
  if [[ ! $mode =~ ^[0-7]{3,4}$ ]] || (( (8#$mode & 0022) != 0 )); then
    echo 'INVALID_INSTALL' >&2; return 3
  fi
}

if [ "$#" -eq 3 ] && [ "$1" = '--audit-parent' ]; then
  [[ $3 =~ ^[0-9]+$ ]] || exit 2
  check_secure_dir "$2" "$3"
  exit
fi
if [ "$#" -eq 3 ] && [ "$1" = '--audit-entry' ]; then
  [[ $3 =~ ^[0-9]+$ ]] || exit 2
  check_secure_entry "$2" "$3"
  exit
fi

if [ "$#" -ne 2 ]; then echo 'INVALID_ARGUMENT' >&2; exit 2; fi
login_id=$1
install_root=$2
if [[ ! $login_id =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
   [[ ! $HOME =~ ^/home/[A-Za-z_][A-Za-z0-9_-]*$ ]] ||
   [ "$(id -un)" != "${HOME##*/}" ] ||
   [[ ! $install_root =~ ^/home/[A-Za-z_][A-Za-z0-9_-]*(/[A-Za-z0-9_.-]+)+$ ]] ||
   [[ $install_root == *'/../'* || $install_root == *'/./'* || $install_root == /mnt/* ]] ||
   [[ $install_root != "$HOME"/* ]]; then
  echo 'INVALID_ARGUMENT' >&2; exit 2
fi

uid=$(id -u)
check_secure_dir / 0
check_secure_dir /home 0
check_secure_dir "$HOME" "$uid"
if [ -L "$HOME/.local" ] || { [ -e "$HOME/.local" ] && [ ! -d "$HOME/.local" ]; }; then
  echo 'UNSAFE_PARENT' >&2; exit 3
fi
if [ ! -d "$HOME/.local" ]; then mkdir -m 700 -- "$HOME/.local"; fi
check_secure_dir "$HOME/.local" "$uid"
base="$HOME/.local/repoconduit-private-homes"
if [ -L "$base" ] || { [ -e "$base" ] && [ ! -d "$base" ]; }; then
  echo 'UNSAFE_PARENT' >&2; exit 3
fi
if [ ! -d "$base" ]; then mkdir -m 700 -- "$base"; fi
check_secure_dir "$base" "$uid"
if [ "$(stat -c %a -- "$base")" != 700 ]; then echo 'UNSAFE_PARENT' >&2; exit 3; fi

current=$HOME
relative=${install_root#"$HOME"/}
IFS=/ read -r -a parts <<< "$relative"
for part in "${parts[@]}" package bin; do
  current="$current/$part"
  check_secure_dir "$current" "$uid"
done
entry="$current/codex.js"
check_secure_entry "$entry" "$uid"

root="$base/$login_id"
if [ -e "$root" ] || [ -L "$root" ]; then echo 'ALREADY_EXISTS' >&2; exit 4; fi
mkdir -m 700 -- "$root"
mkdir -m 700 -- "$root/home" "$root/home/.codex" "$root/workspace"
config="$root/home/.codex/config.toml"
set -C
{
  printf 'default_permissions = "investigator"\n\n'
  printf '[permissions.investigator.filesystem]\n'
  printf '":minimal" = "read"\n'
  printf '"%s" = "read"\n' "$install_root"
  printf '[permissions.investigator.filesystem.":workspace_roots"]\n'
  printf '"." = "read"\n'
  printf '[permissions.investigator.network]\n'
  printf 'enabled = false\n'
} > "$config"
chmod 600 -- "$config"
printf 'PRIVATE_HOME_READY\n'
