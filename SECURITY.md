# Security

Pier runs an AI agent on your machine and lets it reach your files, your repositories and
your lab machines: its protections matter, and a flaw in them is worth reporting.

## Reporting a flaw

Please report it **privately**, not in a public issue: on GitHub, open the repository's
**Security** tab, then **Report a vulnerability**. Say what is affected (Pier on the PC,
the picker on the VM, the CI or the releases), how to reproduce it, and what it lets an
attacker do. You get an answer within a week.

Things worth reporting, among others:

- anything that lets Pi, in its sandbox, reach what it should not: another project, your
  home, the forge's token, the labs' key, the network beyond its allowlist;
- an approval that does something other than what it showed;
- a way for the VM, or a program on it, to act on the PC beyond what Pier lets it
  (files, clipboard, links, shares);
- anything that could get an update past Pier's signature check.

## Supported versions

Only the latest release gets fixes: Pier updates itself, and the picker on the VM follows
it.
