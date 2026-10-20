// ============================================================
// JANTAR MANTAR: CHAOS PROTOCOL — SERVER (Colyseus)
// ============================================================
import pkg from "colyseus";
const { Room, Server } = pkg;
import { Schema, MapSchema, defineTypes } from "@colyseus/schema";
import express from "express";
import { createServer } from "http";

const MAP_W = 1200, MAP_H = 900;
const CAPTURE_RADIUS = 140;
const NPC_RECRUIT_RADIUS = 50;
const TICK_RATE = 20; // Hz

// ---------- SCHEMAS (defineTypes — no decorators) ----------
class Player extends Schema {
  constructor() {
    super();
    this.side = "protestor";
    this.x = 400;
    this.y = 500;
    this.shieldActive = false;
  }
}
defineTypes(Player, {
  side: "string",
  x: "number",
  y: "number",
  shieldActive: "boolean",
});

class NPC extends Schema {
  constructor() {
    super();
    this.x = 0;
    this.y = 0;
    this.recruitedBy = "none";
  }
}
defineTypes(NPC, {
  x: "number",
  y: "number",
  recruitedBy: "string",
});

class State extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.npcs = new MapSchema();
    this.meter = 50;
  }
}
defineTypes(State, {
  players: { map: Player },
  npcs: { map: NPC },
  meter: "number",
});

// ---------- ROOM ----------
class GameRoom extends Room {
  onCreate() {
    this.setState(new State());
    this.maxClients = 20;
    this.spawnNPCs(30);
    this.setSimulationInterval((dt) => this.tick(dt), 1000 / TICK_RATE);
  }

  spawnNPCs(n) {
    for (let i = 0; i < n; i++) {
      const npc = new NPC();
      npc.x = Math.random() * (MAP_W - 200) + 100;
      npc.y = Math.random() * (MAP_H - 200) + 100;
      this.state.npcs.set(`npc_${i}_${Date.now()}_${Math.random()}`, npc);
    }
  }

  onJoin(client, options) {
    const p = new Player();
    p.side = options.side || "protestor";
    p.x = MAP_W / 2 + (Math.random() - 0.5) * 300;
    p.y = MAP_H / 2 + (Math.random() - 0.5) * 300;
    this.state.players.set(client.sessionId, p);
    client.send("welcome", { side: p.side });
  }

  onMessage(client, type, message) {
    const p = this.state.players.get(client.sessionId);
    if (!p) return;

    switch (type) {
      case "move":
        p.x = clamp(message.x, 0, MAP_W);
        p.y = clamp(message.y, 0, MAP_H);
        break;

      case "nara":
        this.broadcast("nara", { text: message.text, x: p.x, y: p.y }, { except: client });
        break;

      case "push":
        this.broadcast("push", { x: p.x, y: p.y }, { except: client });
        if (dist(p.x, p.y, MAP_W / 2, MAP_H / 2) < CAPTURE_RADIUS + 30) {
          this.state.meter = clamp(this.state.meter + 2, 0, 100);
        }
        break;

      case "shield":
        p.shieldActive = message.active;
        break;

      case "lathi": {
        if (p.shieldActive) return;
        this.broadcast("push", { x: p.x, y: p.y }, { except: client });
        this.state.npcs.forEach((npc) => {
          if (npc.recruitedBy === "protestor" && dist(p.x, p.y, npc.x, npc.y) < 80) {
            npc.recruitedBy = "none";
            npc.x += (Math.random() - 0.5) * 100;
            npc.y += (Math.random() - 0.5) * 100;
          }
        });
        break;
      }
    }
  }

  tick(dt) {
    const players = Array.from(this.state.players.values());
    const protestors = players.filter((p) => p.side === "protestor");
    const police = players.filter((p) => p.side === "police");

    // NPC recruitment
    this.state.npcs.forEach((npc) => {
      if (npc.recruitedBy !== "none") return;
      for (const p of protestors) {
        if (dist(p.x, p.y, npc.x, npc.y) < NPC_RECRUIT_RADIUS) {
          npc.recruitedBy = "protestor";
          break;
        }
      }
    });

    // Follow recruiter
    this.state.npcs.forEach((npc) => {
      if (npc.recruitedBy === "protestor" && protestors.length > 0) {
        const nearest = protestors.reduce((a, b) =>
          dist(npc.x, npc.y, a.x, a.y) < dist(npc.x, npc.y, b.x, b.y) ? a : b
        );
        npc.x = lerp(npc.x, nearest.x + (Math.random() - 0.5) * 40, 0.04);
        npc.y = lerp(npc.y, nearest.y + (Math.random() - 0.5) * 40, 0.04);
      }
    });

    // Tug-of-war
    let protestorsInZone = 0;
    for (const p of protestors) {
      if (dist(p.x, p.y, MAP_W / 2, MAP_H / 2) < CAPTURE_RADIUS) protestorsInZone++;
    }
    this.state.npcs.forEach((npc) => {
      if (
        npc.recruitedBy === "protestor" &&
        dist(npc.x, npc.y, MAP_W / 2, MAP_H / 2) < CAPTURE_RADIUS
      ) {
        protestorsInZone += 0.3;
      }
    });

    let policeInZone = 0;
    for (const p of police) {
      if (dist(p.x, p.y, MAP_W / 2, MAP_H / 2) < CAPTURE_RADIUS) policeInZone++;
    }

    const delta = (protestorsInZone * 1.5 - policeInZone * 2.5) * (dt / 1000);
    this.state.meter = clamp(this.state.meter + delta, 0, 100);
  }

  onLeave(client) {
    this.state.players.delete(client.sessionId);
  }
}

// ---------- UTILS ----------
function dist(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ---------- BOOTSTRAP ----------
const app = express();
app.get("/", (_req, res) => res.send("Jantar Mantar server is alive 🪧"));
const server = createServer(app);
const gameServer = new Server({ server });
gameServer.define("jantar_room", GameRoom);
const PORT = process.env.PORT || 2567;
gameServer.listen(PORT);
console.log(`Listening on ws://localhost:${PORT}`);
