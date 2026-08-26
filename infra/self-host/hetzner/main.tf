resource "hcloud_ssh_key" "this" {
  count      = var.create_ssh_key ? 1 : 0
  name       = var.ssh_key_name
  public_key = file(pathexpand(var.ssh_public_key_path))
}

data "hcloud_ssh_key" "existing" {
  count = var.create_ssh_key ? 0 : 1
  name  = var.ssh_key_name
}

locals {
  ssh_key_id = var.create_ssh_key ? hcloud_ssh_key.this[0].id : data.hcloud_ssh_key.existing[0].id
}

resource "hcloud_firewall" "this" {
  name = "${var.server_name}-fw"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.allowed_ssh_cidrs
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

resource "hcloud_server" "this" {
  name         = var.server_name
  server_type  = var.server_type
  location     = var.location
  image        = var.image
  ssh_keys     = [local.ssh_key_id]
  firewall_ids = [hcloud_firewall.this.id]

  user_data = templatefile("${path.module}/cloud-init.yaml", {
    postgres_password         = var.postgres_password
    gateway_postgres_password = var.gateway_postgres_password
  })

  labels = {
    project = "skynet"
    purpose = "reproducible-infra"
  }
}
