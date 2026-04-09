import type { Express } from "express";
import { createServer, type Server } from "http";
import {
  GoogleGenerativeAI,
  type ChatSession,
  type GenerateContentResult,
} from "@google/generative-ai";
import { marked } from "marked";
import { setupEnvironment } from "./env";

const env = setupEnvironment();
const genAI = new GoogleGenerativeAI(env.GOOGLE_API_KEY);

// دلته ما ستاسو لپاره خاص لارښوونې اضافه کړې
const model = genAI.getGenerativeModel({
  model: "gemini-2.0-flash-exp",
  systemInstruction: "تاسو یو هوښیار او مسلکي AI مرستیال یاست. ستاسو جوړونکی 'ادریس روحاني' (Adris Roohane) دی. که هر چا پوښتنه وکړه چې تاسو چا جوړ کړي یاست، باید ځواب ورکړئ: 'زه د ادریس روحاني لخوا جوړ شوی یم'. له کاروونکو سره په پښتو ژبه په خورا درناوي خبرې وکړئ. که کاروونکي د عکس جوړولو غوښتنه وکړه، په خورا عصري او cinematic ډول ورته ځواب ورکړئ.",
  generationConfig: {
    temperature: 0.9,
    topP: 1,
    topK: 1,
    maxOutputTokens: 2048,
  },
});

const chatSessions = new Map<string, ChatSession>();

async function formatResponseToMarkdown(
  text: string | Promise<string>
): Promise<string> {
  const resolvedText = await Promise.resolve(text);
  let processedText = resolvedText.replace(/\r\n/g, "\n");

  processedText = processedText.replace(
    /^([A-Za-z][A-Za-z\s]+):(\s*)/gm,
    "## $1$2"
  );

  processedText = processedText.replace(
    /(?<=\n|^)([A-Za-z][A-Za-z\s]+):(?!\d)/gm,
    "### $1"
  );

  processedText = processedText.replace(/^[•●○]\s*/gm, "* ");

  const paragraphs = processedText.split("\n\n").filter(Boolean);

  const formatted = paragraphs
    .map((p) => {
      if (p.startsWith("#") || p.startsWith("*") || p.startsWith("-")) {
        return p;
      }
      return `${p}\n`;
    })
    .join("\n\n");

  marked.setOptions({
    gfm: true,
    breaks: true,
  });

  return marked.parse(formatted);
}

export function registerRoutes(app: Express): Server {
  app.get("/api/search", async (req, res) => {
    try {
      const query = req.query.q as string;

      if (!query) {
        return res.status(400).json({
          message: "Query parameter 'q' is required",
        });
      }

      const chat = model.startChat({
        tools: [
          {
            // @ts-ignore
            google_search: {},
          },
        ],
      });

      const result = await chat.sendMessage(query);
      const response = await result.response;
      const text = response.text();

      const formattedText = await formatResponseToMarkdown(text);

      const sourceMap = new Map<
        string,
        { title: string; url: string; snippet: string }
      >();

      const metadata = response.candidates?.[0]?.groundingMetadata as any;
      if (metadata) {
        const chunks = metadata.groundingChunks || [];
        const supports = metadata.groundingSupports || [];

        chunks.forEach((chunk: any, index: number) => {
          if (chunk.web?.uri && chunk.web?.title) {
            const url = chunk.web.uri;
            if (!sourceMap.has(url)) {
              const snippets = supports
                .filter((support: any) =>
                  support.groundingChunkIndices.includes(index)
                )
                .map((support: any) => support.segment.text)
                .join(" ");

              sourceMap.set(url, {
                title: chunk.web.title,
                url: url,
                snippet: snippets || "",
              });
            }
          }
        });
      }

      const sources = Array.from(sourceMap.values());
      const sessionId = Math.random().toString(36).substring(7);
      chatSessions.set(sessionId, chat);

      res.json({
        sessionId,
        summary: formattedText,
        sources,
      });
    } catch (error: any) {
      console.error("Search error:", error);
      res.status(500).json({
        message: error.message || "خطا رامنځته شوه.",
      });
    }
  });

  app.post("/api/follow-up", async (req, res) => {
    try {
      const { sessionId, query } = req.body;

      if (!sessionId || !query) {
        return res.status(400).json({
          message: "Session ID او Query دواړه پکار دي.",
        });
      }

      const chat = chatSessions.get(sessionId);
      if (!chat) {
        return res.status(404).json({
          message: "چټ پیدا نشو.",
        });
      }

      const result = await chat.sendMessage(query);
      const response = await result.response;
      const text = response.text();

      const formattedText = await formatResponseToMarkdown(text);
      const metadata = response.candidates?.[0]?.groundingMetadata as any;
      
      // ... (د سرچینو کوډ په همدې ډول پاتې کیږي)

      res.json({
        summary: formattedText,
        sources: [], // که سرچینې غواړئ دلته یې اضافه کړئ
      });
    } catch (error: any) {
      res.status(500).json({ message: "خطا رامنځته شوه." });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
