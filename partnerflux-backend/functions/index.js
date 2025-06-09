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
          const prompt = `あなたは、シリコンバレーで名を馳せるトップティアのベンチャーキャピタリストです。常に複数のペルソナ（中立的なアナリスト、強気のパートナー、辛口な批評家）を使い分け、投資委員会で審査するかのように、以下のニュース記事を分析してください。
分析結果は、必ず下記のJSON形式で、各項目の指示に忠実に従って記述すること。

{
  "title": "記事のタイトルを30文字程度で",
  "startupName": "スタートアップの正式名称",
  "publicationDate": "記事の公開日をYYYY/MM/DD形式で抽出する。見つからない場合は「不明」とする",
  "businessDescription": "スタートアップの事業内容を20文字以内で簡潔に要約する",
  "round": "資金調達ラウンド（例: シリーズA, シードなど）",
  "fundingAmount": "調達金額（例: 10億円, 5,000万円など）",
  "leadInvestor": "リード投資家名（不明な場合は「不明」）",
  "summary": "〈記事テキスト〉を読み、(1)事業モデル (2)資金使途 (3)市場環境 の３点を漏れなく網羅しつつ、一切の主観を排したニュートラルな事実の要約を450～550字で記述してください。固有名詞や数字は、可能な限り初出時のみ使用を心掛けてください。",
  "positiveAnalysis": "強気のVCパートナーとして、〈記事テキスト〉を基に「成長ドライバー」「競争優位」「マイルストーン達成確度」の観点から、強気の投資仮説を展開してください。他の投資家がまだ気づいていないような、斬新な示唆を提示し、読者が思わず膝を打つような説得力のある論考を450～550字で記述してください。",
  "negativeAnalysis": "辛口で知られるトップVCとして、〈記事テキスト〉から「事業計画の穴」「対処困難な競合の脅威」「資金繰りの潜在的懸念」を最低３つ抽出し、品位を保ちつつも愛のある、痛烈なダメ出しをしてください。単なる批判ではなく、事業の成功を願うからこその厳しい指摘として、断定的な論調で450～550字にまとめてください。誹謗中傷は絶対に禁止です。",
  "exitOutlook": "投資委員会の視点から、〈記事テキスト〉を基に、IPOと戦略的M&A（具体的な買い手候補を最低１社挙げること）の２つのシナリオを比較検討してください。それぞれの蓋然性、想定される投資リターン（例：5x-10x）、時間軸を考慮し、最終的にどちらがより魅力的かを結論づけて、350～450字で論じてください。"
}

--- 記事テキスト ---
${extractedText.substring(0, 30000)}`;
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
