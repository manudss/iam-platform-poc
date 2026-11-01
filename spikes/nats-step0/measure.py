#!/usr/bin/env python3
"""Mesure nats-server : mémoire résidente et CPU, avec bridage CPU optionnel.
Pas de cgroup disponible : le bridage est un cycle SIGSTOP/SIGCONT (approximation de 0,1 CPU).
Usage : measure.py <nats-server> <conf> <duty> <scenario> [scenario...]   (duty 1.0 = sans bridage)"""
import os, signal, subprocess, sys, threading, time
srv, conf, duty, scen = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4:]
here = os.path.dirname(os.path.abspath(__file__))
binp = os.path.join(here, "target/release/nats-step0-spike")
port = [l.split(":")[1].strip() for l in open(conf) if l.startswith("port:")][0]
subprocess.run(["rm", "-rf", "/tmp/js-spike"])
p = subprocess.Popen([srv, "-c", conf], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
def rss(): return int([l for l in open(f"/proc/{p.pid}/status") if l.startswith("VmRSS")][0].split()[1]) / 1024
def cpu():
    f = open(f"/proc/{p.pid}/stat").read().rsplit(")", 1)[1].split()
    return (int(f[11]) + int(f[12])) / os.sysconf("SC_CLK_TCK")
stop = False
def throttle():
    period = 0.1
    while not stop:
        os.kill(p.pid, signal.SIGCONT); time.sleep(period * duty)
        os.kill(p.pid, signal.SIGSTOP); time.sleep(period * (1 - duty))
    os.kill(p.pid, signal.SIGCONT)
time.sleep(1.5)
print(f"serveur démarré, RSS au repos {rss():.1f} Mo, bridage duty={duty}")
if duty < 1: threading.Thread(target=throttle, daemon=True).start()
peak = 0
for s in scen:
    c0, t0 = cpu(), time.time()
    r = subprocess.Popen([binp, s, f"127.0.0.1:{port}"], stdout=subprocess.PIPE, text=True, env={**os.environ, "LOAD_N": os.environ.get("LOAD_N", "200")})
    while r.poll() is None:
        peak = max(peak, rss()); time.sleep(0.05)
    out = r.stdout.read().strip()
    print(f"--- {s} ({time.time()-t0:.1f} s, CPU serveur {cpu()-c0:.2f} s)\n{out}")
print(f"RSS final {rss():.1f} Mo, pic {peak:.1f} Mo")
stop = True; time.sleep(0.3); p.terminate()
