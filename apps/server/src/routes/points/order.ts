import { Router } from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { getPointsOrder } from "@/utils/multiTenant/pointsPayment";

export default Router().get("/", async (req, res) => {
  const id = z.uuid().parse(req.query.id);
  res.set("Cache-Control", "no-store").json(success(await getPointsOrder(req, id)));
});
