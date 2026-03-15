import mongoose, { Document, Schema } from "mongoose";

export interface SmsDoc extends Document {
  deviceId: string;
  sender: string;
  senderNumber?: string;   // <-- added (optional)
  receiver: string; // device's phone (local) or recipient when queued
  title?: string;
  body: string;
  timestamp: number; // when SMS was received (ms since epoch)
  createdAt?: Date;
  updatedAt?: Date;
  meta?: Record<string, any>;
}

const SmsSchema = new Schema<SmsDoc>(
  {
    deviceId: { type: String, required: true, index: true },
    sender: { type: String, required: true },
    senderNumber: { type: String, default: "" }, // <-- added to schema
    receiver: { type: String, required: true },
    title: { type: String, default: "" },
    body: { type: String, required: true },
    timestamp: { type: Number, required: true },
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// index created for queries by device + timestamp
SmsSchema.index({ deviceId: 1, timestamp: -1 });

export default mongoose.model<SmsDoc>("Sms", SmsSchema);
