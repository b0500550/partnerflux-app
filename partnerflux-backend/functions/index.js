const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const cors = require("cors")({origin: true});
const axios = require("axios");
const cheerio = require("cheerio");
const {GoogleGenerativeAI} = require("@google/generative-ai");

admin.initializeApp();
const db = admin.firestore();

const config = functions.config();
const GEMINI_API_KEY = config.gemini && config.gemini.key;
if (!GEMINI_API_KEY) {
  functions.logger.error("Gemini APIキーが設定されていません。");
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

/**
 * HTMLから主要なテキストコンテンツを抽出します。
 * @param {string} html スクレイピング対象のHTML。
 * @return {string} 抽出されたテキスト。
 */
function extractMainContent(html) {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header, noscript, form, iframe").remove();
  const mainContent = $("article, main, .content, .main, body")
      .first().text();
  return mainContent.replace(/\s\s+/g, " ").trim();
}

/**
 * AIの応答テキストからJSON部分を安全に抽出します。
 * @param {string} text AIの応答テキスト。
 * @return {object} パースされたJSONオブジェクト。
 */
function parseJsonResponse(text) {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (match && match[1]) {
    return JSON.parse(match[1]);
  }
  return JSON.parse(text);
}

exports.processNewsUrl = functions
    .runWith({timeoutSeconds: 300, memory: "1GB"})
    .region("asia-northeast1")
    .https.onRequest((req, res) => {
      cors(req, res, async () => {
        if (req.method !== "POST") {
          return res.status(405).send("Method Not Allowed");
        }
        const {url, userId} = req.body;
        if (!url || !userId) {
          return res.status(400).send("URL and UserId are required.");
        }
        try {
          const response = await axios.get(url, {
            headers: {"User-Agent": "Mozilla/5.0"},
          });
          const extractedText = extractMainContent(response.data);
          if (extractedText.length < 100) {
            throw new Error("記事本文を十分に抽出できませんでした。");
          }
          const model = genAI.getGenerativeModel({model: "gemini-1.5-flash"});
          const prompt = `以下のニュース記事を分析し、指定されたJSON形式で回答してください。JSON以外の説明文は含めないでください。{"title": "記事のタイトルを30文字程度で","startupName": "スタートアップの正式名称","round": "資金調達ラウンド（例: シリーズA, シードなど）","fundingAmount": "調達金額（例: 10億円, 5,000万円など）","leadInvestor": "リード投資家名（不明な場合は「不明」）","summary": "ニュースの内容を400字程度で要約","positiveAnalysis": "このニュースに関するポジティブな分析を400字程度で","negativeAnalysis": "このニュースに関するネガティブな分析を400字程度で","exitOutlook": "想定されるExit戦略についての見立てを300字程度で"}--- 記事テキスト ---${extractedText.substring(0, 30000)}`;
          const result = await model.generateContent(prompt);
          const analyzedData = parseJsonResponse(result.response.text());
          const projectId = JSON.parse(process.env.FIREBASE_CONFIG).projectId;
          const collectionPath = `artifacts/${projectId}/public/data/news`;
          const docRef = await db.collection(collectionPath).add({
            originalUrl: url, ...analyzedData,
            registeredAt: admin.firestore.FieldValue.serverTimestamp(),
            registeredBy: userId, status: "published",
          });
          return res.status(200).json({
            message: "ニュースの分析と保存が完了しました。", docId: docRef.id, data: analyzedData,
          });
        } catch (error) {
          functions.logger.error("処理中にエラー:", error);
          return res.status(500).send(error.message);
        }
      });
    });

exports.getNewsList = functions
    .region("asia-northeast1")
    .https.onRequest((req, res) => {
      cors(req, res, async () => {
        if (req.method !== "GET") {
          return res.status(405).send("Method Not Allowed");
        }
        try {
          const projectId = JSON.parse(process.env.FIREBASE_CONFIG).projectId;
          const newsRef = db.collection(`artifacts/${projectId}/public/data/news`);
          const snapshot = await newsRef.get();
          if (snapshot.empty) {
            return res.status(200).json([]);
          }
          const newsList = [];
          snapshot.forEach((doc) => {
            const data = doc.data();
            newsList.push({
              id: doc.id,
              ...data,
              registeredAtMillis: data.registeredAt.toMillis(),
            });
          });
          newsList.sort((a, b) => b.registeredAtMillis - a.registeredAtMillis);
          const results = newsList.map((item) => {
            const {registeredAtMillis, ...rest} = item;
            rest.registeredAt = new Date(item.registeredAtMillis)
                .toISOString();
            return rest;
          });
          return res.status(200).json(results);
        } catch (error) {
          functions.logger.error("ニュース一覧の取得中にエラー:", error);
          return res.status(500).send("Failed to get news list.");
        }
      });
    });

// ★★★ CORSの処理方法を修正 ★★★
exports.getNewsDetail = functions
    .region("asia-northeast1")
    .https.onRequest(async (req, res) => {
      // レスポンスにCORSヘッダーを直接設定
      res.set("Access-Control-Allow-Origin", "*");

      if (req.method === "OPTIONS") {
        // CORSのpreflightリクエストに応答
        res.set("Access-Control-Allow-Methods", "GET");
        res.set("Access-Control-Allow-Headers", "Content-Type");
        res.set("Access-Control-Max-Age", "3600");
        return res.status(204).send("");
      }

      // GETリクエストの処理
      if (req.method !== "GET") {
        return res.status(405).send("Method Not Allowed");
      }
      try {
        const newsId = req.query.id;
        if (!newsId) {
          return res.status(400).send("News ID is required.");
        }

        const projectId = JSON.parse(process.env.FIREBASE_CONFIG).projectId;
        const docRef = db.doc(
            `artifacts/${projectId}/public/data/news/${newsId}`,
        );
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
          return res.status(404).send("News not found.");
        }

        const data = docSnap.data();
        const result = {
          id: docSnap.id,
          ...data,
          registeredAt: data.registeredAt.toDate().toISOString(),
        };

        return res.status(200).json(result);
      } catch (error) {
        functions.logger.error("ニュース詳細の取得中にエラー:", error);
        return res.status(500).send("Failed to get news detail.");
      }
    });
