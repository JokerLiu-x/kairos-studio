import { Router } from "express";
import { receivePointsPayment } from "@/utils/multiTenant/pointsPayment";

export default Router().post("/", async (req, res) => {
  try {
    const accepted = req.is("application/x-www-form-urlencoded") && await receivePointsPayment(req.body);
    res.type("text/plain").send(accepted ? "success" : "failure");
  } catch (cause) {
    console.error("积分付款通知未处理", (cause as { status?: number } | null)?.status ?? 500);
    res.status(503).type("text/plain").send("failure");
  }
});
