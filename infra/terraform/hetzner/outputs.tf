output "server_ip" {
  value       = hcloud_server.this.ipv4_address
  description = "Public IPv4 of the server."
}

output "server_id" {
  value       = hcloud_server.this.id
  description = "Hetzner server id."
}

output "ssh" {
  value       = "ssh root@${hcloud_server.this.ipv4_address}"
  description = "SSH command (once cloud-init finishes)."
}

output "cloud_init_status" {
  value       = "ssh root@${hcloud_server.this.ipv4_address} 'cloud-init status --wait'"
  description = "Command to wait for provisioning to complete."
}
