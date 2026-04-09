import express from "express";
import { chat, loadConversation } from "../controllers/chatController.js";
const router = express.Router();

router.post("/", chat);
router.get("/load", loadConversation);

export default router;
