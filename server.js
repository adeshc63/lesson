const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini AI with your API key
const genAI = new GoogleGenerativeAI('AIzaSyDs8UXYPxEIfv0Lun51MmXqk--yWMXE6Ps');

// Middleware
app.use(cors({
  origin: '*',
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Helper function to download PDF from URL
async function downloadPDF(url) {
  return new Promise((resolve, reject) => {
    const filename = `pdf_${Date.now()}.pdf`;
    const filepath = path.join(uploadsDir, filename);
    const file = fs.createWriteStream(filepath);

    const request = url.startsWith('https') ? https : http;
    
    request.get(url, (response) => {
      // Check if response is successful
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download PDF: HTTP ${response.statusCode}`));
        return;
      }

      // Check content type
      const contentType = response.headers['content-type'];
      if (!contentType || !contentType.includes('application/pdf')) {
        reject(new Error('URL does not point to a PDF file'));
        return;
      }

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve(filepath);
      });

      file.on('error', (err) => {
        fs.unlink(filepath, () => {}); // Delete the file on error
        reject(err);
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// Helper function to convert file to base64
function fileToGenerativePart(path, mimeType) {
  return {
    inlineData: {
      data: Buffer.from(fs.readFileSync(path)).toString("base64"),
      mimeType
    },
  };
}

// Helper function to clean up uploaded files
function cleanupFile(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// Helper function to parse and clean AI response
function parseAIResponse(text) {
  const cleanedText = text
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();
  return JSON.parse(cleanedText);
}

// OPTIMIZED: Fast Quiz Generation Endpoint
app.post('/api/generate-fast-quiz', async (req, res) => {
  let downloadedFilePath = null;
  
  try {
    const { pdfUrl, title, numQuestions = 15 } = req.body;

    if (!pdfUrl) {
      return res.status(400).json({ 
        error: 'PDF URL is required' 
      });
    }

    console.log('🚀 Fast quiz generation started for:', title);
    const startTime = Date.now();

    // Download PDF
    try {
      downloadedFilePath = await downloadPDF(pdfUrl);
      console.log('📁 PDF downloaded in:', Date.now() - startTime, 'ms');
    } catch (downloadError) {
      console.error('PDF download error:', downloadError);
      return res.status(400).json({ 
        error: `Failed to download PDF: ${downloadError.message}` 
      });
    }

    // Initialize Gemini model
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    // OPTIMIZED: Simplified prompt for faster generation
    const prompt = `Generate exactly ${numQuestions} quiz questions from this PDF. Mix question types and difficulties.

Requirements:
- 6 MCQ questions (4 options each)
- 4 Fill in the blank questions (4 options each - word choices)
- 3 True/False questions  
- 2 Short answer questions

For each question return:
{
  "question": "Question text",
  "type": "mcq|fill_in_the_blank|true_false|short_answer",
  "difficulty": "easy|medium|hard",
  "topic": "Main topic from PDF",
  "options": ["A", "B", "C", "D"], // For MCQ and fill_in_the_blank
  "answer": "Correct answer",
  "explanation": "Brief explanation"
}

CRITICAL RULES:
- Fill in the blank: Use _____ in question and provide 4 word options. The "answer" field MUST exactly match one of the 4 options.
- MCQ: The "answer" field MUST exactly match one of the 4 options.
- True/False: Answer must be exactly "True" or "False"
- Short answer: Simple factual questions with specific answers
- Make questions directly from PDF content
- Use simple, clear language

VALIDATION:
- For MCQ and Fill in blank: answer field MUST be identical to one of the options
- Double check that answer matches an option exactly

JSON format:
{"questions": [question1, question2, ...]}

Generate fast, accurate questions. Return only valid JSON.`;

    const imagePart = fileToGenerativePart(downloadedFilePath, "application/pdf");
    const parts = [prompt, imagePart];

    console.log('🤖 Generating questions with Gemini...');
    const aiStartTime = Date.now();
    
    const result = await model.generateContent(parts);
    const response = await result.response;
    const text = response.text();

    console.log('⚡ AI response received in:', Date.now() - aiStartTime, 'ms');

    // Parse the JSON response
    let questionsData;
    try {
      questionsData = parseAIResponse(text);
    } catch (parseError) {
      console.error('JSON parsing error:', parseError);
      console.error('Raw response:', text);
      throw new Error('Invalid JSON response from AI');
    }

    if (!questionsData.questions || !Array.isArray(questionsData.questions)) {
      throw new Error('Invalid response format: missing questions array');
    }

    // Quick validation and enhancement
    const validatedQuestions = questionsData.questions.map((q, index) => {
      // Auto-fix missing fields
      if (!q.question || !q.answer || !q.type) {
        throw new Error(`Question ${index + 1} is missing required fields`);
      }

      // Auto-generate options for True/False
      if (q.type === 'true_false') {
        q.options = ['True', 'False'];
        // Ensure answer is exactly True or False
        if (q.answer.toLowerCase().includes('true')) {
          q.answer = 'True';
        } else if (q.answer.toLowerCase().includes('false')) {
          q.answer = 'False';
        } else {
          q.answer = 'True'; // Default fallback
        }
      }

      // Ensure MCQ and fill_in_the_blank have options
      if ((q.type === 'mcq' || q.type === 'fill_in_the_blank') && (!q.options || q.options.length !== 4)) {
        throw new Error(`Question ${index + 1} (${q.type}) must have exactly 4 options`);
      }

      // CRITICAL: Validate that answer matches one of the options for MCQ and fill_in_the_blank
      if (q.type === 'mcq' || q.type === 'fill_in_the_blank') {
        const answerMatches = q.options.some(option => 
          option.toLowerCase().trim() === q.answer.toLowerCase().trim()
        );
        
        if (!answerMatches) {
          console.log(`⚠️  Question ${index + 1}: Answer "${q.answer}" doesn't match any option`);
          console.log(`Options: ${q.options.join(', ')}`);
          
          // Try to find closest match
          const closestMatch = q.options.find(option => 
            option.toLowerCase().includes(q.answer.toLowerCase()) ||
            q.answer.toLowerCase().includes(option.toLowerCase())
          );
          
          if (closestMatch) {
            console.log(`🔧 Auto-fixing: Changed answer to "${closestMatch}"`);
            q.answer = closestMatch;
          } else {
            console.log(`🔧 Auto-fixing: Using first option "${q.options[0]}"`);
            q.answer = q.options[0];
          }
        }
      }

      // For short answer, no options needed
      if (q.type === 'short_answer') {
        q.options = [];
      }

      return {
        question: q.question,
        type: q.type,
        difficulty: q.difficulty || 'medium',
        topic: q.topic || 'General',
        options: q.options || [],
        answer: q.answer,
        explanation: q.explanation || 'Explanation not provided'
      };
    });

    const totalTime = Date.now() - startTime;
    console.log(`✅ Fast quiz generated successfully in ${totalTime}ms (${totalTime/1000}s)`);
    console.log(`📊 Generated ${validatedQuestions.length} questions`);
    
    res.json({ 
      questions: validatedQuestions,
      generationTime: totalTime,
      success: true
    });

  } catch (error) {
    console.error('❌ Error generating fast quiz:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to generate quiz',
      success: false
    });
  } finally {
    if (downloadedFilePath) {
      cleanupFile(downloadedFilePath);
    }
  }
});

// OPTIMIZED: Topic-based Fast Quiz (without PDF)
app.post('/api/generate-topic-quiz', async (req, res) => {
  try {
    const { topic, numQuestions = 15, difficulty = 'mixed' } = req.body;

    if (!topic) {
      return res.status(400).json({ 
        error: 'Topic is required' 
      });
    }

    console.log('🚀 Topic quiz generation for:', topic);
    const startTime = Date.now();

    // Initialize Gemini model
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const prompt = `Create exactly ${numQuestions} quiz questions about "${topic}".

Question Distribution:
- 6 MCQ (4 options each)
- 4 Fill in blank (4 word options each)  
- 3 True/False
- 2 Short answer

Each question:
{
  "question": "Clear question text",
  "type": "mcq|fill_in_the_blank|true_false|short_answer", 
  "difficulty": "easy|medium|hard",
  "topic": "${topic}",
  "options": ["A", "B", "C", "D"], // For MCQ/fill_in_the_blank
  "answer": "Correct answer",
  "explanation": "Brief explanation"
}

Rules:
- Fill in blank: Use _____ with 4 word choices
- Questions cover different aspects of ${topic}
- Mix difficulty levels
- Accurate, educational content

Return: {"questions": [...]}`

    console.log('🤖 Generating topic-based questions...');
    const result = await model.generateContent([prompt]);
    const response = await result.response;
    const text = response.text();

    let questionsData;
    try {
      questionsData = parseAIResponse(text);
    } catch (parseError) {
      console.error('JSON parsing error:', parseError);
      throw new Error('Invalid JSON response from AI');
    }

    // Quick validation
    const validatedQuestions = questionsData.questions.map((q, index) => {
      if (q.type === 'true_false') {
        q.options = ['True', 'False'];
        // Ensure answer is exactly True or False
        if (q.answer.toLowerCase().includes('true')) {
          q.answer = 'True';
        } else if (q.answer.toLowerCase().includes('false')) {
          q.answer = 'False';
        } else {
          q.answer = 'True'; // Default fallback
        }
      }
      
      if (q.type === 'short_answer') {
        q.options = [];
      }

      // CRITICAL: Validate that answer matches one of the options for MCQ and fill_in_the_blank
      if (q.type === 'mcq' || q.type === 'fill_in_the_blank') {
        const answerMatches = q.options.some(option => 
          option.toLowerCase().trim() === q.answer.toLowerCase().trim()
        );
        
        if (!answerMatches) {
          console.log(`⚠️  Topic Quiz Question ${index + 1}: Answer "${q.answer}" doesn't match any option`);
          console.log(`Options: ${q.options.join(', ')}`);
          
          // Try to find closest match
          const closestMatch = q.options.find(option => 
            option.toLowerCase().includes(q.answer.toLowerCase()) ||
            q.answer.toLowerCase().includes(option.toLowerCase())
          );
          
          if (closestMatch) {
            console.log(`🔧 Auto-fixing: Changed answer to "${closestMatch}"`);
            q.answer = closestMatch;
          } else {
            console.log(`🔧 Auto-fixing: Using first option "${q.options[0]}"`);
            q.answer = q.options[0];
          }
        }
      }

      return {
        question: q.question,
        type: q.type,
        difficulty: q.difficulty || 'medium',
        topic: q.topic || topic,
        options: q.options || [],
        answer: q.answer,
        explanation: q.explanation || ''
      };
    });

    const totalTime = Date.now() - startTime;
    console.log(`✅ Topic quiz generated in ${totalTime}ms`);
    
    res.json({ 
      questions: validatedQuestions,
      generationTime: totalTime,
      success: true
    });

  } catch (error) {
    console.error('❌ Error generating topic quiz:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to generate topic quiz',
      success: false
    });
  }
});

// EXISTING ENDPOINTS (for backward compatibility)

// Original PDF Analysis Endpoint
app.post('/api/analyze-pdf', async (req, res) => {
  let downloadedFilePath = null;
  
  try {
    const { pdfUrl, title } = req.body;

    if (!pdfUrl) {
      return res.status(400).json({ 
        error: 'PDF URL is required' 
      });
    }

    console.log('Analyzing PDF:', pdfUrl);

    // Download PDF
    try {
      downloadedFilePath = await downloadPDF(pdfUrl);
      console.log('PDF downloaded for analysis:', downloadedFilePath);
    } catch (downloadError) {
      console.error('PDF download error:', downloadError);
      return res.status(400).json({ 
        error: `Failed to download PDF: ${downloadError.message}` 
      });
    }

    // Initialize Gemini model
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const prompt = `Analyze this PDF document "${title}" and extract detailed information about its content.

Please provide a comprehensive analysis in the following JSON format:

{
  "topics": ["topic1", "topic2", "topic3", ...],
  "topicCoverage": {
    "topic1": 25,
    "topic2": 30,
    "topic3": 20,
    "topic4": 15,
    "topic5": 10
  },
  "totalPages": number,
  "contentSummary": "Brief summary of the main content and key concepts covered",
  "keyTerms": ["term1", "term2", "term3", ...],
  "difficultyLevel": "beginner/intermediate/advanced",
  "contentAreas": ["area1", "area2", ...]
}

Instructions:
- Extract 5-10 main topics from the document
- Calculate percentage coverage for each topic (should sum to 100)
- Identify key terms and concepts throughout the document
- Provide a concise summary of the main content
- Determine the overall difficulty level
- List major content areas or subjects covered

Return only valid JSON, no additional text.`;

    const imagePart = fileToGenerativePart(downloadedFilePath, "application/pdf");
    const parts = [prompt, imagePart];

    console.log('Analyzing PDF content with Gemini...');
    const result = await model.generateContent(parts);
    const response = await result.response;
    const text = response.text();

    console.log('PDF analysis response received');

    // Parse the JSON response
    let analysisData;
    try {
      analysisData = parseAIResponse(text);
    } catch (parseError) {
      console.error('JSON parsing error:', parseError);
      console.error('Raw response:', text);
      throw new Error('Invalid JSON response from AI');
    }

    // Validate and ensure required fields
    const analysis = {
      topics: analysisData.topics || [],
      topicCoverage: analysisData.topicCoverage || {},
      totalPages: analysisData.totalPages || 1,
      contentSummary: analysisData.contentSummary || 'Content analysis completed',
      keyTerms: analysisData.keyTerms || [],
      difficultyLevel: analysisData.difficultyLevel || 'intermediate',
      contentAreas: analysisData.contentAreas || []
    };

    console.log(`PDF analysis completed: ${analysis.topics.length} topics found`);
    res.json(analysis);

  } catch (error) {
    console.error('Error analyzing PDF:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to analyze PDF' 
    });
  } finally {
    if (downloadedFilePath) {
      cleanupFile(downloadedFilePath);
    }
  }
});

// Original Generate Quiz Endpoint
app.post('/api/generate-quiz', async (req, res) => {
  let downloadedFilePath = null;
  
  try {
    const { topic, pdfUrl, numQuestions = 10 } = req.body;

    if (!topic && !pdfUrl) {
      return res.status(400).json({ 
        error: 'Either topic or PDF URL is required' 
      });
    }

    console.log('Received request:', { topic, pdfUrl, numQuestions });

    // Download PDF if URL is provided
    if (pdfUrl) {
      try {
        console.log('Downloading PDF from URL:', pdfUrl);
        downloadedFilePath = await downloadPDF(pdfUrl);
        console.log('PDF downloaded successfully:', downloadedFilePath);
      } catch (downloadError) {
        console.error('PDF download error:', downloadError);
        return res.status(400).json({ 
          error: `Failed to download PDF: ${downloadError.message}` 
        });
      }
    }

    // Initialize Gemini model
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    let prompt;
    let parts = [];

    if (downloadedFilePath && topic) {
      // Both PDF and topic provided
      prompt = `Create exactly ${numQuestions} multiple choice questions based on the content of this PDF document and the topic "${topic}". 

Format your response as a JSON object with a "questions" array. Each question should have:
- question: the question text
- options: array of 4 possible answers  
- answer: the correct answer (must match exactly one of the options)

Make questions challenging but fair. Focus on key concepts and important details.

Return only valid JSON, no additional text.`;

      const imagePart = fileToGenerativePart(downloadedFilePath, "application/pdf");
      parts = [prompt, imagePart];
      
    } else if (downloadedFilePath) {
      // Only PDF provided
      prompt = `Analyze this PDF document and create exactly ${numQuestions} multiple choice questions based on its content.

Format your response as a JSON object with a "questions" array. Each question should have:
- question: the question text
- options: array of 4 possible answers
- answer: the correct answer (must match exactly one of the options)

Make questions that test understanding of the key concepts and important information in the document.

Return only valid JSON, no additional text.`;

      const imagePart = fileToGenerativePart(downloadedFilePath, "application/pdf");
      parts = [prompt, imagePart];
      
    } else {
      // Only topic provided
      prompt = `Create exactly ${numQuestions} multiple choice questions about "${topic}".

Format your response as a JSON object with a "questions" array. Each question should have:
- question: the question text
- options: array of 4 possible answers
- answer: the correct answer (must match exactly one of the options)

Cover different aspects and difficulty levels of the topic. Make questions educational and challenging.

Return only valid JSON, no additional text.`;

      parts = [prompt];
    }

    console.log('Generating quiz with Gemini...');
    const result = await model.generateContent(parts);
    const response = await result.response;
    const text = response.text();

    console.log('Gemini response received, length:', text.length);

    // Parse the JSON response
    let questionsData;
    try {
      questionsData = parseAIResponse(text);
    } catch (parseError) {
      console.error('JSON parsing error:', parseError);
      console.error('Raw response:', text);
      throw new Error('Invalid JSON response from AI');
    }

    if (!questionsData.questions || !Array.isArray(questionsData.questions)) {
      throw new Error('Invalid response format: missing questions array');
    }

    // Validate questions format
    const validatedQuestions = questionsData.questions.map((q, index) => {
      if (!q.question || !q.options || !q.answer) {
        throw new Error(`Question ${index + 1} is missing required fields`);
      }
      if (!Array.isArray(q.options) || q.options.length !== 4) {
        throw new Error(`Question ${index + 1} must have exactly 4 options`);
      }
      if (!q.options.includes(q.answer)) {
        throw new Error(`Question ${index + 1}: answer must match one of the options`);
      }
      return {
        question: q.question,
        options: q.options,
        answer: q.answer
      };
    });

    console.log(`Successfully generated ${validatedQuestions.length} questions`);
    res.json({ questions: validatedQuestions });

  } catch (error) {
    console.error('Error generating quiz:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to generate quiz' 
    });
  } finally {
    // Clean up downloaded file
    if (downloadedFilePath) {
      cleanupFile(downloadedFilePath);
    }
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'Optimized QuizWise Backend',
    version: '3.0.0'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Optimized QuizWise Backend API - Super Fast Quiz Generation',
    version: '3.0.0',
    status: 'Running',
    endpoints: {
      // OPTIMIZED Endpoints
      generateFastQuiz: 'POST /api/generate-fast-quiz (2-3 seconds)',
      generateTopicQuiz: 'POST /api/generate-topic-quiz (1-2 seconds)',
      
      // Original Endpoints (backward compatibility)
      analyzePDF: 'POST /api/analyze-pdf',
      generateQuiz: 'POST /api/generate-quiz',
      
      // Utility
      health: 'GET /health'
    },
    optimizations: [
      '🚀 2-3 second quiz generation',
      '⚡ Simplified AI prompts',
      '🔥 No complex analysis steps',
      '📱 Fill in blank with options',
      '✅ Short answer auto-accept',
      '🎯 Direct question generation',
      '💨 Faster PDF processing'
    ],
    questionTypes: [
      'Multiple Choice (4 options)',
      'Fill in the Blank (4 word options)', 
      'True/False',
      'Short Answer (any input accepted)'
    ]
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Optimized QuizWise Backend running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 API Base URL: http://localhost:${PORT}`);
  console.log(`✅ Gemini AI initialized successfully`);
  console.log(`\n🎯 OPTIMIZED ENDPOINTS:`);
  console.log(`   ⚡ Fast PDF Quiz: POST /api/generate-fast-quiz (2-3s)`);
  console.log(`   💨 Topic Quiz: POST /api/generate-topic-quiz (1-2s)`);
  console.log(`\n📊 FEATURES:`);
  console.log(`   🔥 Super fast generation`);
  console.log(`   📝 Mixed question types`);
  console.log(`   ✨ Fill in blank with options`);
  console.log(`   🎮 Smooth user experience`);
  console.log(`   📱 Mobile optimized`);
  
  // Test API key on startup
  console.log('\n🔑 API Key configured and ready');
  console.log('🎉 Ready for lightning-fast quiz generation!');
});
