import { Router } from "express";
import { success } from "@/lib/responseFormat";
import { pointsCatalog } from "@/utils/multiTenant/pointsPayment";

export default Router().get("/", (req, res) => {
  res.set("Cache-Control", "no-store").json(success(pointsCatalog(req)));
});
