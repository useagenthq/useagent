const ROOT_TRAVERSAL_PATHS = new Set([
  "/root",
  "/root/.skynet",
  "/root/.skynet/t3",
  "/root/.skynet/t3/userdata",
]);

function shq(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function numericIdentity(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value !== 1000) {
    throw new Error(`${label} must be the verified runtime identity 1000`);
  }
  return value;
}

const STRICT_UNSUPPORTED_ACL_CLASSIFIER = [
  "acl_failure_is_only_unsupported() {",
  "  LC_ALL=C awk '",
  "    BEGIN { seen = 0; invalid = 0 }",
  "    /^setfacl: [^:]+: (Operation not supported|Not supported)$/ { seen = 1; next }",
  "    NF { invalid = 1 }",
  "    END { exit !(seen && !invalid) }",
  "  ' \"$1\"",
  "}",
].join("\n");

export function buildRootTraversalAccessCommand(input: {
  readonly paths: readonly string[];
  readonly uid: number;
  readonly gid: number;
}): string {
  const uid = numericIdentity(input.uid, "uid");
  const gid = numericIdentity(input.gid, "gid");
  if (
    input.paths.length === 0 ||
    input.paths.some((path) => !ROOT_TRAVERSAL_PATHS.has(path))
  ) {
    throw new Error("root traversal access contains an unsupported path");
  }
  const paths = input.paths.map(shq).join(" ");
  return [
    `test "$(id -u user)" = "${uid}"`,
    `test "$(id -g user)" = "${gid}"`,
    "command -v setfacl >/dev/null",
    STRICT_UNSUPPORTED_ACL_CLASSIFIER,
    `for ACCESS_PATH in ${paths}; do`,
    '  test -d "$ACCESS_PATH"',
    '  test ! -L "$ACCESS_PATH"',
    '  test "$(realpath -e -- "$ACCESS_PATH")" = "$ACCESS_PATH"',
    "done",
    "ACL_ERROR=$(mktemp)",
    `if LC_ALL=C setfacl -m "u:${uid}:x" ${paths} 2>"$ACL_ERROR"; then`,
    '  rm -f -- "$ACL_ERROR"',
    'elif acl_failure_is_only_unsupported "$ACL_ERROR"; then',
    '  rm -f -- "$ACL_ERROR"',
    `  for ACCESS_PATH in ${paths}; do`,
    `    chown root:${gid} -- "$ACCESS_PATH"`,
    '    chmod 0710 -- "$ACCESS_PATH"',
    `    test "$(stat -c '%u:%g:%a' -- "$ACCESS_PATH")" = "0:${gid}:710"`,
    "  done",
    "else",
    '  cat "$ACL_ERROR" >&2',
    '  rm -f -- "$ACL_ERROR"',
    "  exit 1",
    "fi",
  ].join("\n");
}

export function buildAttachmentTreeAccessCommand(input: {
  readonly root: string;
  readonly uid: number;
  readonly gid: number;
}): string {
  const uid = numericIdentity(input.uid, "uid");
  const gid = numericIdentity(input.gid, "gid");
  if (input.root !== "/root/.skynet/t3/userdata/attachments") {
    throw new Error("attachment access contains an unsupported root");
  }
  return [
    `ATTACHMENTS_ROOT=${shq(input.root)}`,
    STRICT_UNSUPPORTED_ACL_CLASSIFIER,
    'if [ -e "$ATTACHMENTS_ROOT" ] || [ -L "$ATTACHMENTS_ROOT" ]; then',
    '  test -d "$ATTACHMENTS_ROOT"',
    '  test ! -L "$ATTACHMENTS_ROOT"',
    '  test "$(realpath -e -- "$ATTACHMENTS_ROOT")" = "$ATTACHMENTS_ROOT"',
    '  ACL_ERROR=$(mktemp)',
    `  if LC_ALL=C setfacl -Rm "u:${uid}:rwx" "$ATTACHMENTS_ROOT" 2>"$ACL_ERROR" && find -P "$ATTACHMENTS_ROOT" -xdev -type d -exec env LC_ALL=C setfacl -m "d:u:${uid}:rwx" -- {} + 2>>"$ACL_ERROR"; then`,
    '    rm -f -- "$ACL_ERROR"',
    '  elif acl_failure_is_only_unsupported "$ACL_ERROR"; then',
    '    rm -f -- "$ACL_ERROR"',
    `    find -P "$ATTACHMENTS_ROOT" -xdev -type d -exec chgrp -h ${gid} -- {} +`,
    '    find -P "$ATTACHMENTS_ROOT" -xdev -type d -exec chmod 2770 -- {} +',
    `    find -P "$ATTACHMENTS_ROOT" -xdev -type f -exec chgrp -h ${gid} -- {} +`,
    '    find -P "$ATTACHMENTS_ROOT" -xdev -type f -exec chmod g+rw,o-rwx -- {} +',
    `    INVALID_ATTACHMENT_DIR=$(find -P "$ATTACHMENTS_ROOT" -xdev -type d \\( ! -gid ${gid} -o ! -perm 2770 \\) -print -quit)`,
    '    test -z "$INVALID_ATTACHMENT_DIR"',
    `    INVALID_ATTACHMENT_FILE=$(find -P "$ATTACHMENTS_ROOT" -xdev -type f \\( ! -gid ${gid} -o ! -perm -0060 -o -perm /0007 \\) -print -quit)`,
    '    test -z "$INVALID_ATTACHMENT_FILE"',
    "  else",
    '    cat "$ACL_ERROR" >&2',
    '    rm -f -- "$ACL_ERROR"',
    "    exit 1",
    "  fi",
    "fi",
  ].join("\n");
}
