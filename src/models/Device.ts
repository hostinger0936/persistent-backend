import mongoose, { Document, Schema } from "mongoose";

/* ───────────────────────────────────────────
   Sub-interfaces
   ─────────────────────────────────────────── */

export interface SimInfo {
  uniqueid: string;
  sim1Number?: string;
  sim1Carrier?: string;
  sim1Slot?: number | null;
  sim2Number?: string;
  sim2Carrier?: string;
  sim2Slot?: number | null;
}

export interface SimSlotState {
  status?: string;
  updatedAt?: number;
}

/**
 * LastSeen — the ONLY source of truth for device reachability.
 *
 * Updated when:
 *  - App receives SMS and forwards it
 *  - App receives FCM and executes command
 *  - App sends SMS on server command
 *  - App forwards a call (USSD result)
 *  - App opens (app_open)
 *  - App boots (boot)
 *  - Periodic heartbeat from WorkManager (every 15 min)
 *
 * Panel interprets:
 *  - 0–15 min ago  → "Responsive" (green)
 *  - 15 min–2 hr   → "Idle" (amber)
 *  - 2 hr+         → "Unreachable" (red)
 */
export interface LastSeen {
  /** epoch ms — last time the device did anything */
  at: number;
  /** what triggered this update */
  action: string;
  /** device battery percent 0–100, or -1 if unknown */
  battery: number;
}

export interface DeviceMetadata {
  model?: string;
  manufacturer?: string;
  androidVersion?: string;
  brand?: string;
  simOperator?: string;
  registeredAt?: number;
  [k: string]: any;
}

/* ───────────────────────────────────────────
   Main Document interface
   ─────────────────────────────────────────── */

export interface DeviceDoc extends Document {
  deviceId: string;
  metadata: DeviceMetadata;

  /** Device reachability — only source of truth */
  lastSeen: LastSeen;

  admins: string[];
  adminPhone?: string;
  forwardingSim?: string;
  simInfo?: SimInfo | null;
  simSlots?: Record<string, SimSlotState>;
  favorite?: boolean;

  /* ── FCM fields ── */
  fcmToken: string;
  fcmTokenUpdatedAt: number;
  fcmLastAttemptAt?: number | null;
  fcmLastSuccessAt?: number | null;
  fcmLastErrorAt?: number | null;
  fcmLastError?: string;
  fcmLastMessageId?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

/* ───────────────────────────────────────────
   Sub-schemas
   ─────────────────────────────────────────── */

const SimInfoSchema = new Schema<SimInfo>(
  {
    uniqueid: { type: String, required: true },
    sim1Number: { type: String, default: "" },
    sim1Carrier: { type: String, default: "" },
    sim1Slot: { type: Number, default: null },
    sim2Number: { type: String, default: "" },
    sim2Carrier: { type: String, default: "" },
    sim2Slot: { type: Number, default: null },
  },
  { _id: false },
);

const SimSlotStateSchema = new Schema<SimSlotState>(
  {
    status: { type: String, default: "inactive" },
    updatedAt: { type: Number, default: Date.now },
  },
  { _id: false },
);

const LastSeenSchema = new Schema<LastSeen>(
  {
    at: { type: Number, default: 0 },
    action: { type: String, default: "" },
    battery: { type: Number, default: -1 },
  },
  { _id: false },
);

/* ───────────────────────────────────────────
   Main Device schema
   ─────────────────────────────────────────── */

const DeviceSchema = new Schema<DeviceDoc>(
  {
    deviceId: { type: String, required: true, unique: true, index: true },

    metadata: {
      model: { type: String, default: "" },
      manufacturer: { type: String, default: "" },
      androidVersion: { type: String, default: "" },
      brand: { type: String, default: "" },
      simOperator: { type: String, default: "" },
      registeredAt: { type: Number, default: Date.now },
    },

    /** Device reachability — replaces old status.online completely */
    lastSeen: {
      type: LastSeenSchema,
      default: () => ({ at: 0, action: "", battery: -1 }),
    },

    admins: { type: [String], default: [] },
    adminPhone: { type: String, default: "" },
    forwardingSim: { type: String, default: "auto" },
    simInfo: { type: SimInfoSchema, default: null },

    simSlots: {
      type: Map,
      of: SimSlotStateSchema,
      default: {},
    },

    favorite: { type: Boolean, default: false },

    /* ── FCM fields ── */
    fcmToken: { type: String, default: "", index: true },
    fcmTokenUpdatedAt: { type: Number, default: 0 },
    fcmLastAttemptAt: { type: Number, default: null },
    fcmLastSuccessAt: { type: Number, default: null },
    fcmLastErrorAt: { type: Number, default: null },
    fcmLastError: { type: String, default: "" },
    fcmLastMessageId: { type: String, default: "" },
  },
  { timestamps: true },
);

/* ───────────────────────────────────────────
   Indexes
   ─────────────────────────────────────────── */

// Primary query: sort devices by most recently seen
DeviceSchema.index({ "lastSeen.at": -1 });

// Favorites filter
DeviceSchema.index({ favorite: 1 });

// FCM token lookup (sparse — skip docs without token)
DeviceSchema.index({ fcmToken: 1 }, { sparse: true });

export default mongoose.model<DeviceDoc>("Device", DeviceSchema);