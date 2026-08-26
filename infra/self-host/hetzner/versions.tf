# Reproducible Skynet host on Hetzner Cloud.
# The API token is read from the HCLOUD_TOKEN environment variable, never a file
# and never committed. See README.md.
terraform {
  required_version = ">= 1.5.0"
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.48"
    }
  }
}

provider "hcloud" {
  # token comes from HCLOUD_TOKEN in the environment.
}
