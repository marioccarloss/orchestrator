export const SENSITIVE_PATH_RULES: Readonly<Record<string, "deny">> = {
  "~/.ssh/*": "deny",
  "~/.ssh/**/*": "deny",
  "**/*.pem": "deny",
  "**/*.key": "deny",
  "**/.env*": "deny",
  "~/.credentials/*": "deny",
  "~/.aws/credentials": "deny",
  "~/.config/gh/hosts.yml": "deny",
  "~/Library/Keychains/*": "deny",
  "**/secrets/*": "deny",
  "**/*.p12": "deny",
  "**/*.pfx": "deny",
};

export const SENSITIVE_SHELL_RULES: Readonly<Record<string, "deny">> = {
  "*~/.ssh/*": "deny",
  "* ~/.ssh/*": "deny",
  "* .env*": "deny",
  "*/*.pem*": "deny",
  "*/*.key*": "deny",
  "*~/.aws/credentials*": "deny",
  "*~/.config/gh/hosts.yml*": "deny",
  "*~/Library/Keychains/*": "deny",
  "*/secrets/*": "deny",
  "*/*.p12*": "deny",
  "*/*.pfx*": "deny",
};

export const REMOTE_SHELL_RULES: Readonly<Record<string, "ask">> = {
  "ssh *": "ask",
  "scp *": "ask",
  "sftp *": "ask",
  "rsync *:*": "ask",
};

export const SECURITY_BOUNDARY_CONTRACT = `Security boundary (mandatory): never read, edit, copy, print, summarize, or transmit credential material from .env files, SSH keys, keychains, cloud credentials, provider auth files, certificates, or secrets directories. Do not discover or reuse ambient credentials or sessions. Remote execution or transfer requires explicit authorization naming the destination and operation; local development access is not remote authorization.`;
