# Deployment Pack

This folder contains deployment-oriented artifacts for the Debian + Cloudflare Tunnel target.

## Files

- `systemd/fleet-ai.service` - example systemd unit for running Fleet AI as a service
- `cloudflared/config.example.yml` - example Cloudflare Tunnel config routing the public hostname to local Fleet AI

## Assumptions

- app code lives at `/opt/fleet-ai`
- service account is `fleetai:fleetai`
- Fleet AI listens on `127.0.0.1:3000`
- Cloudflare Tunnel is the only public ingress path

## Notes

- Adjust usernames, paths, and hostname before install.
- Keep the Node app bound to localhost.
- Do not expose port 3000 directly to the public internet when using Cloudflare Tunnel.
