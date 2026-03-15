import mongoose, { Schema, Document } from "mongoose";

export interface AdminSessionDoc extends Document {
  admin: string;
  deviceId: string;
  lastSeen: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const AdminSessionSchema = new Schema<AdminSessionDoc>(
  {
    admin: { type: String, required: true, index: true },
    deviceId: { type: String, required: true, index: true },
    lastSeen: { type: Number, default: Date.now }
  },
  { timestamps: true }
);

AdminSessionSchema.index({ admin: 1, deviceId: 1 }, { unique: true });

export default mongoose.model<AdminSessionDoc>(
  "AdminSession",
  AdminSessionSchema
);
