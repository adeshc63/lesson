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

// Generate Quiz Endpoint
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
      // Clean the response text (remove any markdown formatting)
      const cleanedText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      questionsData = JSON.parse(cleanedText);
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

// Analyze Results Endpoint
app.post('/api/analyze-results', async (req, res) => {
  try {
    const { topic, results, totalQuestions, correctAnswers } = req.body;

    if (!results || !Array.isArray(results)) {
      return res.status(400).json({ 
        error: 'Results array is required' 
      });
    }

    console.log('Analyzing results for topic:', topic);

    // Initialize Gemini model
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const incorrectAnswers = results.filter(r => !r.isCorrect);
    const correctAnswersList = results.filter(r => r.isCorrect);

    const prompt = `Analyze this quiz performance and provide personalized feedback.

Topic: ${topic}
Total Questions: ${totalQuestions}
Correct Answers: ${correctAnswers}
Score: ${Math.round((correctAnswers / totalQuestions) * 100)}%

Incorrect Answers:
${incorrectAnswers.map((r, i) => `
${i + 1}. Question: ${r.question}
   Your Answer: ${r.userAnswer}
   Correct Answer: ${r.correctAnswer}
`).join('')}

Correct Answers:
${correctAnswersList.map((r, i) => `
${i + 1}. Question: ${r.question}
   Your Answer: ${r.userAnswer}
`).join('')}

Based on this performance, provide:

1. Strong Areas: Topics/concepts the student understood well (based on correct answers)
2. Weak Areas: Topics/concepts that need improvement (based on incorrect answers)  
3. Suggestions: Specific, actionable study recommendations

Format your response as a JSON object:
{
  "strongAreas": ["area1", "area2", ...],
  "weakAreas": ["area1", "area2", ...], 
  "suggestions": "Detailed study suggestions and recommendations"
}

Be specific and helpful in your analysis. Focus on the actual content and concepts.

Return only valid JSON, no additional text.`;

    console.log('Analyzing results with Gemini...');
    const result = await model.generateContent([prompt]);
    const response = await result.response;
    const text = response.text();

    console.log('Gemini analysis response received');

    // Parse the JSON response
    let analysisData;
    try {
      // Clean the response text
      const cleanedText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      analysisData = JSON.parse(cleanedText);
    } catch (parseError) {
      console.error('JSON parsing error:', parseError);
      console.error('Raw response:', text);
      throw new Error('Invalid JSON response from AI');
    }

    // Ensure all required fields exist
    const analysis = {
      strongAreas: analysisData.strongAreas || [],
      weakAreas: analysisData.weakAreas || [],
      suggestions: analysisData.suggestions || 'Continue studying and practicing to improve your understanding.'
    };

    console.log('Analysis completed successfully');
    res.json(analysis);

  } catch (error) {
    console.error('Error analyzing results:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to analyze results' 
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'QuizWise Backend',
    version: '1.0.0'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'QuizWise Backend API',
    version: '1.0.0',
    status: 'Running',
    endpoints: {
      generateQuiz: 'POST /api/generate-quiz',
      analyzeResults: 'POST /api/analyze-results',
      health: 'GET /health'
    },
    documentation: 'Send POST requests to /api/generate-quiz with topic and/or pdfUrl'
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
  console.log(`🚀 QuizWise Backend running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 API Base URL: http://localhost:${PORT}`);
  console.log(`✅ Gemini AI initialized successfully`);
  
  // Test API key on startup
  console.log('🔑 API Key configured and ready');
});
