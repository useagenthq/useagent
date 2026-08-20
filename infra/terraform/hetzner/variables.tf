variable "server_name" {
  type        = string
  default     = "skynet-repro"
  description = "Name/label for the server and its firewall."
}

variable "server_type" {
  type        = string
  default     = "cpx31" # 4 vCPU / 8 GB; enough to build the Next.js frontend
  description = "Hetzner server type. cpx31 is the recommended minimum; cpx41 for headroom."
}

variable "location" {
  type        = string
  default     = "hel1" # Helsinki
  description = "Hetzner location (nbg1, fsn1, hel1, ash, hil, sin)."
}

variable "image" {
  type        = string
  default     = "ubuntu-24.04"
  description = "Base image."
}

variable "ssh_public_key_path" {
  type        = string
  default     = ""
  description = "Path to the SSH public key that may log in as root (e.g. ~/.ssh/id_ed25519.pub). Required when create_ssh_key = true."
}

variable "create_ssh_key" {
  type        = bool
  default     = true
  description = "Create the SSH key in the project (true) or reference an existing one by name (false)."
}

variable "ssh_key_name" {
  type        = string
  default     = "skynet-repro-key"
  description = "Name of the SSH key: created under this name, or looked up by it when create_ssh_key = false."
}

variable "allowed_ssh_cidrs" {
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
  description = "Source CIDRs allowed to reach SSH. Tighten to your IP for anything long-lived."
}

variable "postgres_password" {
  type        = string
  sensitive   = true
  description = "Password for the local 'skynet' Postgres role the stack connects with."
}
