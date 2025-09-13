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

function extractMainContent(html) {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header, noscript, form, iframe").remove();
  const mainContent = $("article, main, .content, .main, body").first().text();
  return mainContent.replace(/\s\s+/g, " ").trim();
}

function parseJsonResponse(text) {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (match && match[1]) {
    try {
      return JSON.parse(match[1]);
    } catch(e) {
      functions.logger.error("Failed to parse JSON from ```json block", e, text);
      throw new Error("Invalid JSON format in ```json block from AI.");
    }
  }
  try {
    return JSON.parse(text);
  } catch(e) {
      functions.logger.error("Failed to parse JSON directly", e, text);
      throw new Error("Invalid JSON format returned from AI.");
  }
}

// ### PROMPT DEFINITIONS ###
const alliancePrompt = `あなたは、世界的な経営コンサルティングファームのシニアパートナーです。常に複数のペルソナ（中立的なアナリスト、楽観的な戦略家、慎重なリスク管理担当）を使い分け、以下の事業提携に関するニュース記事を分析してください。
分析結果は、必ず下記のJSON形式で、各項目の指示に忠実に従って記述すること。また、各分析項目（summary, synergyAnalysis, riskAnalysis, futureOutlook）の文章中では、最も重要だと判断したキーワードやフレーズを3～5箇所選び、**その部分をアスタリスク2つで囲んでください**（例：**これが重要な提携**です）。
{
  "title": "記事のタイトルを30文字程度で",
  "publicationDate": "記事の公開日をYYYY/MM/DD形式で抽出する。見つからない場合は「不明」とする",
  "primaryCompany": "提携における主導的企業の正式名称",
  "partnerCompany": "提携相手企業の正式名称",
  "allianceType": "提携の種類（例: 業務提携, 資本業務提携, 販売代理店契約など）",
  "summary": "〈記事テキスト〉を読み、(1)提携の背景と目的 (2)各社の役割分担 (3)提携が目指す具体的な成果 の３点を漏れなく網羅しつつ、一切の主観を排したニュートラルな事実の要約を400～500字で記述してください。",
  "synergyAnalysis": "楽観的な戦略家として、〈記事テキスト〉を基に「販売網の拡大」「技術の補完関係」「ブランド価値の向上」といった観点から、この提携が生み出すであろう具体的なシナジー効果を多角的に分析し、説得力のある論考を600～700字で記述してください。",
  "riskAnalysis": "慎重なリスク管理担当として、〈記事テキスト〉から「提携解消リスク」「実行計画の曖昧さ」「企業文化の衝突可能性」といった実行上の課題や潜在的リスクを最低３つ抽出し、品位を保ちつつも、具体的な対策案を添えて冷静に指摘してください。600～700字でまとめてください。",
  "futureOutlook": "シニアパートナーの視点から、〈記事テキスト〉を基に、この提携の(1)短期的な業界へのインパクト (2)3〜5年後の中期的な展開 (3)将来的なM&Aへの発展可能性の３つの時間軸で予測してください。その際、競合他社の追随可能性や類似・先行事例を踏まえ、分析を含めてください。全体を600～700字で論じてください。"
}`;

const fundingPrompt = `あなたは、シリコンバレーで名を馳せるトップティアのベンチャーキャピタリストです。常に複数のペルソナ（中立的なアナリスト、強気のパートナー、辛口な批評家）を使い分け、投資委員会で審査するかのように、以下のニュース記事を分析してください。
分析結果は、必ず下記のJSON形式で、各項目の指示に忠実に従って記述すること。また、各分析項目（summary, positiveAnalysis, negativeAnalysis, exitOutlook）の文章中では、最も重要だと判断したキーワードやフレーズを3～5箇所選び、**その部分をアスタリスク2つで囲んでください**（例：**重要な資金使途**です）。
{
  "title": "記事のタイトルを30文字程度で",
  "startupName": "スタートアップの正式名称",
  "publicationDate": "記事の公開日をYYYY/MM/DD形式で抽出する。見つからない場合は「不明」とする",
  "businessDescription": "スタートアップの事業内容を20文字以内で簡潔に要約する",
  "round": "資金調達ラウンド（例: シリーズA, シードなど）",
  "fundingAmount": "調達金額（例: 10億円, 5,000万円など）",
  "leadInvestor": "リード投資家名（不明な場合は「不明」）",
  "summary": "〈記事テキスト〉を読み、(1)事業モデル (2)資金使途 (3)市場環境 の３点を漏れなく網羅しつつ、一切の主観を排したニュートラルな事実の要約を400～500字で記述してください。固有名詞や数字は、可能な限り初出時のみ使用を心掛けてください。",
  "positiveAnalysis": "強気のVCパートナーとして、〈記事テキスト〉を基に「成長ドライバー」「競争優位」「マイルストーン達成確度」の観点から、強気の投資仮説を展開してください。他の投資家がまだ気づいていないような、斬新な示唆を提示し、読者が思わず膝を打つような説得力のある論考を600～700字で記述してください。",
  "negativeAnalysis": "辛口で知られるトップVCとして、〈記事テキスト〉から「事業計画の穴」「対処困難な競合の脅威」「資金繰りの潜在的懸念」を最低３つ抽出し、品位を保ちつつも愛のある、痛烈なダメ出しをしてください。単なる批判ではなく、事業の成功を願うからこその厳しい指摘として、断定的な論調で600～700字にまとめてください。誹謗中傷は絶対に禁止です。",
  "exitOutlook": "投資委員会の視点から、〈記事テキスト〉を基に、IPOと戦略的M&A（具体的な買い手候補を最低2社挙げること）の２つのシナリオを比較検討してください。それぞれの蓋然性を考慮し、最終的にどのようなExitが資金調達会社や投資家にとって魅力的かを結論づけて、600～700字で論じてください。ただし、想定しうる時価総額水準には言及しないでください。"
}`;

const vcNewsPrompt = `あなたは、VCへのLP投資家でもある著名な機関投資家です。提供されたVCのファンド設立に関するニュース記事のテキストを基に、以下のJSON形式に従って、正確かつ洞察に満ちた分析レポートを作成してください。
分析結果は、必ず下記のJSON形式で、各項目の指示に忠実に従って記述すること。また、各分析項目（summary, positiveAnalysis, negativeAnalysis, LPOutlook）の文章中では、最も重要だと判断したキーワードやフレーズを3～5箇所選び、**その部分をアスタリスク2つで囲んでください**。
{
  "title": "記事のタイトルを30文字程度で要約してください。",
  "startupName": "ファンドの正式名称を正確に抽出してください。",
  "publicationDate": "記事の公開日をYYYY/MM/DD形式で抽出してください。見つからない場合は「不明」としてください。",
  "businessDescription": "ファンドニュースの概要を20文字以内で簡潔に要約してください。",
  "fundingAmount": "ファンドの総額（例: 10億円, 5,000万円など）を抽出してください。",
  "summary": "記事テキストを基に、(1)ファンド運営戦略, (2)ファンドマネージャー, (3)投資先の事業ステージや事業領域の３点を漏れなく網羅し、一切の主観を排したニュートラルな事実の要約を400～500字で記述してください。固有名詞や数字は、可能な限り初出時のみの使用を心がけてください。",
  "positiveAnalysis": "LP投資家として、記事テキストを基にファンドの将来性について「成長ドライバー」「競争優位」「マイルストーン達成確度」の観点から、強気の成長仮説を展開してください。他の投資家がまだ気づいていないような、斬新な示唆を提示し、読者が思わず膝を打つような説得力のある論考を600～700字で記述してください。",
  "negativeAnalysis": "LP投資家として、記事テキストから「ファンド戦略の穴」「対処困難な競合の脅威」「市場環境から生じる潜在的懸念」を最低３つ抽出し、品位を保ちつつも愛のある、痛烈なダメ出しをしてください。単なる批判ではなく、事業の成功を願うからこその厳しい指摘として、断定的な論調で600～700字にまとめてください。誹謗中傷は絶対に禁止です。",
  "LPOutlook": "LP投資家の視点から、記事テキストを基に、なぜ他のファンドではなくこのファンドに投資するのか、その際に何を重視しているのかを検討して600～700字で論じてください。ファンドマネージャーの実績やファンドの特異性があれば、そこも考慮してください。"
}`;

// ... (fetchCandidateNews function remains the same) ...
exports.fetchCandidateNews = functions
    .runWith({timeoutSeconds: 540, memory: "1GB"})
    .region("asia-northeast1")
    .https.onRequest((req, res) => {
      cors(req, res, async () => {
        if (req.method !== "GET") {
          return res.status(405).send("Method Not Allowed");
        }

        const requestedCategory = req.query.category;
        if (!requestedCategory || !['funding', 'alliance', 'vc_news'].includes(requestedCategory)) {
            return res.status(400).json({ message: "無効なカテゴリが指定されました。'funding', 'alliance', 'vc_news' のいずれかを指定してください。" });
        }
        
        const keywordsConfig = {
            funding: {
                search: "資金調達",
                verify: ["資金調達"],
            },
            alliance: {
                search: "業務提携",
                verify: ["業務提携", "資本業務提携", "協業", "連携"],
            },
            vc_news: {
                search: "ファンド 設立",
                verify: ["ファンド", "設立", "組成"],
            },
        };

        const config = keywordsConfig[requestedCategory];
        functions.logger.info(`ニュース候補の取得処理を開始します (カテゴリ: ${requestedCategory}, 検索キーワード: "${config.search}")`);
        
        try {
          const projectId = JSON.parse(process.env.FIREBASE_CONFIG).projectId;
          const newsCollection = db.collection(`artifacts/${projectId}/public/data/news`);
          const candidateCollection = db.collection(`artifacts/${projectId}/public/data/candidate_news`);

          const [newsSnapshot, candidateSnapshot] = await Promise.all([
            newsCollection.select("originalUrl").get(),
            candidateCollection.select("url").get(),
          ]);

          const existingUrls = new Set();
          newsSnapshot.forEach((doc) => existingUrls.add(doc.data().originalUrl));
          candidateSnapshot.forEach((doc) => existingUrls.add(doc.data().url));
          functions.logger.info(`既存のURLを ${existingUrls.size} 件確認しました。`);
          
          const uniqueNewArticles = new Map();
          
          const searchUrl = `https://prtimes.jp/main/action.php?run=html&page=searchkey&search_word=${encodeURIComponent(config.search)}`;
          functions.logger.info(`一次スクリーニングを開始します: ${searchUrl}`);
          
          let articlesFromSearch = [];
          try {
            const listPageResponse = await axios.get(searchUrl, {
                headers: {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36"},
            });
            const $list = cheerio.load(listPageResponse.data);
            const jsonDataText = $list('script#__NEXT_DATA__[type="application/json"]').html();
            
            if (jsonDataText) {
                const pageData = JSON.parse(jsonDataText);
                articlesFromSearch = pageData?.props?.pageProps?.dehydratedState?.queries?.[0]?.state?.data?.pages?.[0]?.releaseList || [];
                functions.logger.info(`一次スクリーニング: ${articlesFromSearch.length} 件の記事を抽出しました。`);
            } else {
                functions.logger.warn(`検索結果でJSONデータが見つかりませんでした。`);
            }
          } catch(searchError){
             functions.logger.error(`検索ページの取得でエラー: ${searchUrl}`, searchError.message);
          }

          functions.logger.info(`二次検証（個別記事チェック）を開始します...`);
          for (const article of articlesFromSearch) {
              if (!article.releaseUrl || !article.title) continue;
              
              const fullUrl = `https://prtimes.jp${article.releaseUrl}`;
              if (existingUrls.has(fullUrl) || uniqueNewArticles.has(fullUrl)) continue;

              try {
                  const articlePageResponse = await axios.get(fullUrl, { timeout: 10000 });
                  const $$ = cheerio.load(articlePageResponse.data);

                  let hasOfficialKeyword = false;
                  $$('dt:contains("キーワード")').next('dd').find('a').each((i, elem) => {
                      const keywordText = $$(elem).text().trim();
                      if (config.verify.includes(keywordText)) {
                          hasOfficialKeyword = true;
                          return false;
                      }
                  });

                  if (hasOfficialKeyword) {
                      functions.logger.info(`✅ [検証OK] ${fullUrl}`);
                      uniqueNewArticles.set(fullUrl, {
                          title: article.title,
                          url: fullUrl,
                          category: requestedCategory,
                      });
                  } else {
                      functions.logger.info(`❌ [検証NG] 公式キーワード不一致: ${fullUrl}`);
                  }
              } catch (verifyError) {
                  functions.logger.error(`記事ページの検証エラー: ${fullUrl}`, verifyError.message);
              }
          }

          if (uniqueNewArticles.size > 0) {
            const batch = db.batch();
            uniqueNewArticles.forEach((article) => {
              const candidateRef = candidateCollection.doc();
              batch.set(candidateRef, {
                title: article.title,
                url: article.url,
                category: article.category,
                discoveredAt: admin.firestore.FieldValue.serverTimestamp(),
                status: "candidate",
              });
            });
            await batch.commit();
            const message = `正常に完了: ${uniqueNewArticles.size}件の新しいニュース候補を追加しました。`;
            return res.status(200).json({message: message, count: uniqueNewArticles.size});
          } else {
            const message = "新しいニュース候補は見つかりませんでした。";
            return res.status(200).json({message: message, count: 0});
          }

        } catch (error) {
          functions.logger.error("ニュース候補の取得処理中に重大なエラーが発生しました:", error);
          const errorMessage = error.response ? `外部サイトへのアクセスエラー(ステータス: ${error.response.status})` : error.message;
          return res.status(500).json({message: errorMessage});
        }
      });
    });


exports.processNewsUrl = functions
    .runWith({timeoutSeconds: 300, memory: "1GB"})
    .region("asia-northeast1")
    .https.onRequest((req, res) => {
      cors(req, res, async () => {
        if (req.method !== "POST") {
          return res.status(405).send("Method Not Allowed");
        }
        
        const {url, userId, category} = req.body;
        if (!url || !userId || !category) {
          return res.status(400).json({message: "URL, UserId, Categoryのすべてが必要です。"});
        }
        
        let promptTemplate;
        if (category === "funding") {
          promptTemplate = fundingPrompt;
        } else if (category === "alliance") {
          promptTemplate = alliancePrompt;
        } else if (category === "vc_news") {
          promptTemplate = vcNewsPrompt;
        } else {
          return res.status(400).json({message: "無効なカテゴリです。"});
        }

        try {
          const response = await axios.get(url, {
            headers: {"User-Agent": "Mozilla/5.0"},
          });
          const extractedText = extractMainContent(response.data);

          if (extractedText.length < 100) {
            throw new Error("記事本文を十分に抽出できませんでした。文字数が少なすぎます。");
          }
          const model = genAI.getGenerativeModel({model: "gemini-1.5-pro-latest"});
          const fullPrompt = `${promptTemplate}\n\n--- 記事テキスト ---\n${extractedText.substring(0, 1000000)}`;
          const result = await model.generateContent(fullPrompt);          
          const analyzedData = parseJsonResponse(result.response.text());

          const projectId = JSON.parse(process.env.FIREBASE_CONFIG).projectId;
          const collectionPath = `artifacts/${projectId}/public/data/news`;
          
          const normalizedData = {
            title: analyzedData.title || '',
            publicationDate: analyzedData.publicationDate || '不明',
            businessDescription: analyzedData.businessDescription || '',
            summary: analyzedData.summary || '',
            positiveAnalysis: analyzedData.positiveAnalysis || '',
            negativeAnalysis: analyzedData.negativeAnalysis || '',
            ...(category === 'funding' && {
                startupName: analyzedData.startupName || '',
                round: analyzedData.round || '不明',
                fundingAmount: analyzedData.fundingAmount || '不明',
                leadInvestor: analyzedData.leadInvestor || '不明',
                exitOutlook: analyzedData.exitOutlook || '',
            }),
            ...(category === 'alliance' && {
                primaryCompany: analyzedData.primaryCompany || '',
                partnerCompany: analyzedData.partnerCompany || '',
                allianceType: analyzedData.allianceType || '不明',
                synergyAnalysis: analyzedData.synergyAnalysis || '',
                riskAnalysis: analyzedData.riskAnalysis || '',
                futureOutlook: analyzedData.futureOutlook || '',
            }),
            ...(category === 'vc_news' && {
                startupName: analyzedData.startupName || '',
                fundingAmount: analyzedData.fundingAmount || '不明',
                LPOutlook: analyzedData.LPOutlook || '',
            }),
          };

          const dataToSave = {
            originalUrl: url,
            ...normalizedData,
            registeredAt: admin.firestore.FieldValue.serverTimestamp(),
            registeredBy: userId,
            status: "published",
            category: category,
          };
          
          const docRef = await db.collection(collectionPath).add(dataToSave);

          return res.status(200).json({
            message: "ニュースの分析と保存が完了しました。",
            docId: docRef.id,
            data: dataToSave,
          });
        } catch (error) {
          functions.logger.error("処理中にエラー:", error);
          const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
          return res.status(500).json({message: `エラーが発生しました: ${errorMessage}`});
        }
      });
    });

// ... (getNewsList and getNewsDetail functions remain the same) ...
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


exports.getNewsDetail = functions
    .region("asia-northeast1")
    .https.onRequest(async (req, res) => {
      res.set("Access-Control-Allow-Origin", "*");

      if (req.method === "OPTIONS") {
        res.set("Access-Control-Allow-Methods", "GET");
        res.set("Access-Control-Allow-Headers", "Content-Type");
        res.set("Access-Control-Max-Age", "3600");
        return res.status(204).send("");
      }

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

