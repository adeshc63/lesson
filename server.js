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

// NEW: PDF Analysis Endpoint
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

// NEW: Advanced Quiz Generation Endpoint
app.post('/api/generate-advanced-quiz', async (req, res) => {
  let downloadedFilePath = null;
  
  try {
    const { 
      pdfUrl, 
      analysis, 
      numQuestions = 20, 
      questionTypes = ['mcq', 'fill_in_the_blank', 'true_false', 'short_answer'],
      difficultyDistribution = { easy: 6, medium: 8, hard: 6 },
      topicDistribution = {}
    } = req.body;

    if (!pdfUrl && !analysis) {
      return res.status(400).json({ 
        error: 'PDF URL or analysis data is required' 
      });
    }

    console.log('Generating advanced quiz:', { numQuestions, questionTypes });

    // Download PDF if URL provided
    if (pdfUrl) {
      try {
        downloadedFilePath = await downloadPDF(pdfUrl);
        console.log('PDF downloaded for quiz generation:', downloadedFilePath);
      } catch (downloadError) {
        console.error('PDF download error:', downloadError);
        return res.status(400).json({ 
          error: `Failed to download PDF: ${downloadError.message}` 
        });
      }
    }

    // Initialize Gemini model
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const prompt = `Generate exactly ${numQuestions} questions based on this PDF content with the following specifications:

PDF Analysis:
${JSON.stringify(analysis, null, 2)}

Question Requirements:
- Question Types: ${questionTypes.join(', ')}
- Difficulty Distribution: ${JSON.stringify(difficultyDistribution)}
- Total Questions: ${numQuestions}

For each question, include:
1. Question text that directly relates to PDF content
2. Question type (mcq, fill_in_the_blank, true_false, short_answer)
3. Difficulty level (easy, medium, hard)
4. Related topic from the PDF
5. Correct answer
6. For MCQ: 4 options
7. Explanation of the correct answer

Distribute questions across topics based on their coverage in the PDF.
Ensure questions test different cognitive levels (recall, comprehension, application, analysis).

Return JSON format:
{
  "questions": [
    {
      "question": "Question text here",
      "type": "mcq",
      "difficulty": "medium",
      "topic": "Related topic from PDF",
      "options": ["A", "B", "C", "D"],
      "answer": "Correct answer",
      "explanation": "Why this answer is correct"
    },
    ...
  ]
}

Special Instructions:
- For fill_in_the_blank: Use _____ for blanks
- For true_false: Create factual statements 
- For short_answer: Require 2-3 sentence responses
- For mcq: Ensure 4 plausible options
- Questions must be directly answerable from PDF content
- Vary difficulty appropriately across the distribution

Return only valid JSON, no additional text.`;

    let parts;
    if (downloadedFilePath) {
      const imagePart = fileToGenerativePart(downloadedFilePath, "application/pdf");
      parts = [prompt, imagePart];
    } else {
      parts = [prompt];
    }

    console.log('Generating advanced quiz with Gemini...');
    const result = await model.generateContent(parts);
    const response = await result.response;
    const text = response.text();

    console.log('Advanced quiz response received');

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

    // Validate and enhance questions
    const validatedQuestions = questionsData.questions.map((q, index) => {
      if (!q.question || !q.answer || !q.type) {
        throw new Error(`Question ${index + 1} is missing required fields`);
      }

      // Validate MCQ options
      if (q.type === 'mcq') {
        if (!q.options || !Array.isArray(q.options) || q.options.length !== 4) {
          throw new Error(`Question ${index + 1} (MCQ) must have exactly 4 options`);
        }
        if (!q.options.includes(q.answer)) {
          throw new Error(`Question ${index + 1}: answer must match one of the options`);
        }
      }

      return {
        question: q.question,
        type: q.type,
        difficulty: q.difficulty || 'medium',
        topic: q.topic || 'General',
        options: q.options || [],
        answer: q.answer,
        explanation: q.explanation || 'Correct answer explanation not provided'
      };
    });

    console.log(`Successfully generated ${validatedQuestions.length} advanced questions`);
    res.json({ questions: validatedQuestions });

  } catch (error) {
    console.error('Error generating advanced quiz:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to generate advanced quiz' 
    });
  } finally {
    if (downloadedFilePath) {
      cleanupFile(downloadedFilePath);
    }
  }
});

// NEW: Advanced Results Analysis Endpoint
app.post('/api/analyze-advanced-results', async (req, res) => {
  try {
    const { 
      pdfTitle, 
      pdfAnalysis = {}, 
      results, 
      totalQuestions, 
      correctAnswers,
      topics = []
    } = req.body;

    if (!results || !Array.isArray(results)) {
      return res.status(400).json({ 
        error: 'Results array is required' 
      });
    }

    console.log('Analyzing advanced results for:', pdfTitle);

    // Calculate detailed performance metrics
    const topicScores = {};
    const difficultyPerformance = { easy: 0, medium: 0, hard: 0 };
    const questionTypePerformance = { mcq: 0, fill_in_the_blank: 0, true_false: 0, short_answer: 0 };

    // Calculate topic-wise performance
    topics.forEach(topic => {
      const topicResults = results.filter(r => r.topic === topic);
      const topicCorrect = topicResults.filter(r => r.isCorrect).length;
      topicScores[topic] = topicResults.length > 0 ? (topicCorrect / topicResults.length) : 0;
    });

    // Calculate difficulty-wise performance
    ['easy', 'medium', 'hard'].forEach(diff => {
      const diffResults = results.filter(r => r.difficulty === diff);
      const diffCorrect = diffResults.filter(r => r.isCorrect).length;
      difficultyPerformance[diff] = diffResults.length > 0 ? (diffCorrect / diffResults.length) : 0;
    });

    // Calculate question type performance
    ['mcq', 'fill_in_the_blank', 'true_false', 'short_answer'].forEach(type => {
      const typeResults = results.filter(r => r.type === type);
      const typeCorrect = typeResults.filter(r => r.isCorrect).length;
      questionTypePerformance[type] = typeResults.length > 0 ? (typeCorrect / typeResults.length) : 0;
    });

    // Initialize Gemini model
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const incorrectAnswers = results.filter(r => !r.isCorrect);
    const correctAnswersList = results.filter(r => r.isCorrect);

    const prompt = `Analyze this comprehensive quiz performance and provide detailed educational feedback.

PDF Title: ${pdfTitle}
Total Questions: ${totalQuestions}
Correct Answers: ${correctAnswers}
Overall Score: ${Math.round((correctAnswers / totalQuestions) * 100)}%

PDF Content Analysis:
${JSON.stringify(pdfAnalysis, null, 2)}

Performance Breakdown:
Topic Scores: ${JSON.stringify(topicScores, null, 2)}
Difficulty Performance: ${JSON.stringify(difficultyPerformance, null, 2)}
Question Type Performance: ${JSON.stringify(questionTypePerformance, null, 2)}

Detailed Results:
Incorrect Answers:
${incorrectAnswers.map((r, i) => `
${i + 1}. [${r.difficulty.toUpperCase()}] [${r.type.toUpperCase()}] Topic: ${r.topic}
   Question: ${r.question}
   Your Answer: ${r.userAnswer || 'No answer provided'}
   Correct Answer: ${r.correctAnswer}
   Explanation: ${r.explanation || 'No explanation provided'}
`).join('')}

Correct Answers:
${correctAnswersList.map((r, i) => `
${i + 1}. [${r.difficulty.toUpperCase()}] [${r.type.toUpperCase()}] Topic: ${r.topic}
   Question: ${r.question}
   Your Answer: ${r.userAnswer}
`).join('')}

Based on this comprehensive analysis, provide detailed educational feedback:

1. Strong Areas: Specific topics and concepts the student mastered well
2. Weak Areas: Topics and concepts that need significant improvement  
3. Study Suggestions: Detailed, actionable recommendations for improvement
4. Topic-specific guidance based on performance
5. Learning strategies for different question types

Format as JSON:
{
  "strongAreas": ["specific area 1", "specific area 2", ...],
  "weakAreas": ["specific area 1", "specific area 2", ...],
  "suggestions": "Comprehensive study plan and recommendations based on performance analysis. Include specific topics to review, study methods, and practice suggestions.",
  "topicScores": ${JSON.stringify(topicScores)},
  "difficultyPerformance": ${JSON.stringify(difficultyPerformance)},
  "learningPath": "Recommended learning sequence and focus areas",
  "nextSteps": "Immediate action items for improvement"
}

Be specific, educational, and constructive. Focus on helping the student improve their understanding of the PDF content.

Return only valid JSON, no additional text.`;

    console.log('Analyzing advanced results with Gemini...');
    const result = await model.generateContent([prompt]);
    const response = await result.response;
    const text = response.text();

    console.log('Advanced analysis response received');

    // Parse the JSON response
    let analysisData;
    try {
      analysisData = parseAIResponse(text);
    } catch (parseError) {
      console.error('JSON parsing error:', parseError);
      console.error('Raw response:', text);
      throw new Error('Invalid JSON response from AI');
    }

    // Ensure all required fields exist with enhanced data
    const analysis = {
      strongAreas: analysisData.strongAreas || [],
      weakAreas: analysisData.weakAreas || [],
      suggestions: analysisData.suggestions || 'Continue studying the PDF content to improve understanding.',
      topicScores: analysisData.topicScores || topicScores,
      difficultyPerformance: analysisData.difficultyPerformance || difficultyPerformance,
      questionTypePerformance: questionTypePerformance,
      learningPath: analysisData.learningPath || 'Focus on weak areas identified in the analysis.',
      nextSteps: analysisData.nextSteps || 'Review incorrect answers and study related topics.'
    };

    console.log('Advanced analysis completed successfully');
    res.json(analysis);

  } catch (error) {
    console.error('Error analyzing advanced results:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to analyze advanced results' 
    });
  }
});

// EXISTING: Original Generate Quiz Endpoint (keeping for backward compatibility)
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

// EXISTING: Original Analyze Results Endpoint (keeping for backward compatibility)
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
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

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
      analysisData = parseAIResponse(text);
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
    service: 'Enhanced QuizWise Backend',
    version: '2.0.0'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Enhanced QuizWise Backend API',
    version: '2.0.0',
    status: 'Running',
    endpoints: {
      // New Enhanced Endpoints
      analyzePDF: 'POST /api/analyze-pdf',
      generateAdvancedQuiz: 'POST /api/generate-advanced-quiz',
      analyzeAdvancedResults: 'POST /api/analyze-advanced-results',
      
      // Original Endpoints (backward compatibility)
      generateQuiz: 'POST /api/generate-quiz',
      analyzeResults: 'POST /api/analyze-results',
      
      // Utility
      health: 'GET /health'
    },
    features: [
      'PDF Content Analysis',
      'Multiple Question Types (MCQ, Fill in the Blank, True/False, Short Answer)',
      'Difficulty Level Distribution (Easy, Medium, Hard)',
      'Topic-based Question Generation',
      'Advanced Performance Analysis',
      'Educational Recommendations'
    ],
    documentation: 'Enhanced PDF Quiz Generation with Multiple Question Types and Advanced Analytics'
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
  console.log(`🚀 Enhanced QuizWise Backend running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 API Base URL: http://localhost:${PORT}`);
  console.log(`✅ Gemini AI initialized successfully`);
  console.log(`🆕 New Enhanced Features:`);
  console.log(`   📊 PDF Analysis: POST /api/analyze-pdf`);
  console.log(`   🧠 Advanced Quiz: POST /api/generate-advanced-quiz`);
  console.log(`   📈 Advanced Analysis: POST /api/analyze-advanced-results`);
  console.log(`🔄 Backward compatibility maintained for existing endpoints`);
  
  // Test API key on startup
  console.log('🔑 API Key configured and ready');
});
