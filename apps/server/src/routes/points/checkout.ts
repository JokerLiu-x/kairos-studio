import { Router } from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { createPointsOrder } from "@/utils/multiTenant/pointsPayment";

export default Router().post("/", async (req, res) => {
  const { packId, id } = z.strictObject({ packId: z.string().max(32), id: z.uuid() }).parse(req.body);
  res.set("Cache-Control", "no-store").json(success(await createPointsOrder(req, packId, id)));
});
