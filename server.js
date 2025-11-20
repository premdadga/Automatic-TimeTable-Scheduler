const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const PORT = 3000;

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// MongoDB Connection
mongoose.connect('mongodb://localhost:27017/timetable', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB Connected'))
  .catch(err => console.log('MongoDB Error:', err));

// Schemas
const courseSchema = new mongoose.Schema({
  code: String,
  name: String,
  faculty: String,
  duration: Number,
  type: String,
  branch: String,
  section: { type: String, default: 'ALL' },
  year: Number,
  credits: { type: Number, default: 3 },
  semesterHalf: { type: String, default: '0' },
  basket: { type: Number, default: 0 },
  isElective: { type: Boolean, default: false },
  sharedWith: { type: String, default: '' } // NEW: Cross-branch scheduling
});

const facultySchema = new mongoose.Schema({
  name: String,
  department: String,
  availability: [String]
});

const roomSchema = new mongoose.Schema({
  number: String,
  capacity: Number,
  type: String
});

const timetableSchema = new mongoose.Schema({
  day: String,
  timeSlot: String,
  course: String,
  faculty: String,
  room: String,
  type: String,
  branch: String,
  section: { type: String, default: 'ALL' },
  year: Number,
  semesterHalf: String,
  generatedAt: { type: Date, default: Date.now },
  isShared: { type: Boolean, default: false }, // NEW: Mark shared courses
  sharedWith: { type: String, default: '' } // NEW: Track what it's shared with
});

const Course = mongoose.model('Course', courseSchema);
const Faculty = mongoose.model('Faculty', facultySchema);
const Room = mongoose.model('Room', roomSchema);
const Timetable = mongoose.model('Timetable', timetableSchema);

// File Upload Setup
const upload = multer({ dest: 'uploads/' });

// Time Slots
const timeSlots = [
  '09:00 - 10:00',
  '10:00 - 10:30',
  '10:45 - 11:00',
  '11:00 - 12:00',
  '12:00 - 12:15',
  '12:15 - 12:30',
  '12:30 - 13:15',
  '14:00 - 14:30',
  '14:30 - 15:30',
  '15:30 - 15:40',
  '15:40 - 16:00',
  '16:00 - 16:30',
  '16:30 - 17:10',
  '17:10 - 17:30',
  '17:30 - 18:30'
];

const days = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];

// Helper function to calculate duration of a time slot in minutes
function getSlotDuration(slot) {
  const [start, end] = slot.split(' - ');
  const [startHour, startMin] = start.split(':').map(Number);
  const [endHour, endMin] = end.split(':').map(Number);
  
  const startMinutes = startHour * 60 + startMin;
  const endMinutes = endHour * 60 + endMin;
  
  return endMinutes - startMinutes;
}

// Define continuous time blocks (avoiding breaks)
function getContinuousTimeBlocks() {
  return [
    {
      name: 'morning',
      slots: ['09:00 - 10:00', '10:00 - 10:30']
    },
    {
      name: 'late-morning',
      slots: [
        '10:45 - 11:00',
        '11:00 - 12:00',
        '12:00 - 12:15',
        '12:15 - 12:30',
        '12:30 - 13:15'
      ]
    },
    {
      name: 'afternoon',
      slots: [
        '14:00 - 14:30',
        '14:30 - 15:30',
        '15:30 - 15:40',
        '15:40 - 16:00',
        '16:00 - 16:30',
        '16:30 - 17:10',
        '17:10 - 17:30',
        '17:30 - 18:30'
      ]
    }
  ];
}

// Find consecutive slots within continuous blocks that match target duration
function findSlotsForDuration(targetMinutes) {
  const blocks = getContinuousTimeBlocks();
  const validCombinations = [];
  
  blocks.forEach(block => {
    for (let startIdx = 0; startIdx < block.slots.length; startIdx++) {
      let totalMinutes = 0;
      const selectedSlots = [];
      
      for (let i = startIdx; i < block.slots.length; i++) {
        const slot = block.slots[i];
        const duration = getSlotDuration(slot);
        selectedSlots.push(slot);
        totalMinutes += duration;
        
        if (Math.abs(totalMinutes - targetMinutes) <= 5) {
          validCombinations.push({
            slots: [...selectedSlots],
            totalMinutes: totalMinutes,
            block: block.name
          });
          break;
        }
        
        if (totalMinutes > targetMinutes + 5) {
          break;
        }
      }
    }
  });
  
  return validCombinations;
}

// NEW: Parse shared targets from comma/semicolon separated string
function parseSharedTargets(sharedWith) {
  if (!sharedWith || sharedWith.trim() === '') return [];
  
  const cleaned = sharedWith.replace(/;/g, ',');
  return cleaned.split(',')
    .map(t => t.trim().toLowerCase())
    .filter(t => t.length > 0);
}

// NEW: Find partner course(s) for cross-branch/section scheduling
function findPartnerCourse(course, candidatePool, assignedIds) {
  if (!course.sharedWith || course.sharedWith.trim() === '') {
    return null;
  }

  const courseTargets = parseSharedTargets(course.sharedWith);
  if (courseTargets.length === 0) return null;

  const courseBranch = course.branch.toLowerCase();
  const courseSection = (course.section || 'ALL').toLowerCase();
  const courseCode = course.code.toLowerCase();
  const courseYear = String(course.year);

  for (const candidate of candidatePool) {
    // Skip if already assigned or same course
    if (assignedIds.has(candidate._id.toString()) || 
        candidate._id.toString() === course._id.toString()) {
      continue;
    }

    // Must be same course code
    if (candidate.code.toLowerCase() !== courseCode) {
      continue;
    }

    const candidateBranch = candidate.branch.toLowerCase();
    const candidateSection = (candidate.section || 'ALL').toLowerCase();
    const candidateYear = String(candidate.year);
    
    // Must be same year
    if (candidateYear !== courseYear) {
      continue;
    }

    // Create identifiers for matching
    const candidateFullId = `${candidateBranch}-${candidateSection}`;
    const courseFullId = `${courseBranch}-${courseSection}`;

    // Must be different branch OR different section
    if (candidateBranch === courseBranch && candidateSection === courseSection) {
      continue;
    }

    // Check if candidate matches our targets (branch, section, or branch-section combination)
    const matchesTarget = courseTargets.some(target => {
      const targetLower = target.toLowerCase();
      return targetLower === candidateBranch || 
             targetLower === candidateSection ||
             targetLower === candidateFullId ||
             targetLower === candidate.code.toLowerCase();
    });

    if (!matchesTarget) {
      continue;
    }

    // Check if we are in candidate's targets
    const candidateTargets = parseSharedTargets(candidate.sharedWith || '');
    const weMatchCandidate = candidateTargets.some(target => {
      const targetLower = target.toLowerCase();
      return targetLower === courseBranch || 
             targetLower === courseSection ||
             targetLower === courseFullId ||
             targetLower === courseCode;
    });

    if (!weMatchCandidate) {
      continue;
    }

    return candidate;
  }

  return null;
}

// Routes
app.get('/', (req, res) => {
  res.render('index');
});

app.get('/clear-db', async (req, res) => {
  try {
    await Timetable.deleteMany({});
    await Course.deleteMany({});
    console.log('Database cleared');
    res.send('Database cleared');
  } catch (error) {
    console.error('Error clearing database:', error);
    res.status(500).send('Error clearing database');
  }
});

app.post('/upload/courses', upload.single('file'), async (req, res) => {
  try {
    const results = [];
    fs.createReadStream(req.file.path)
      .pipe(csv())
      .on('data', (data) => {
        const cleanData = {
          code: data.code ? data.code.trim() : '',
          name: data.name ? data.name.trim() : '',
          faculty: data.faculty ? data.faculty.trim() : '',
          duration: parseInt(data.duration) || 1,
          type: data.type ? data.type.trim() : 'Lecture',
          branch: data.branch ? data.branch.trim() : '',
          section: data.section ? data.section.trim() : 'ALL',
          year: parseInt(data.year) || 1,
          credits: parseInt(data.credits) || 3,
          semesterHalf: data.semesterHalf ? String(data.semesterHalf).trim() : '0',
          basket: parseInt(data.basket) || 0,
          isElective: data.isElective === '1' || data.isElective === 'true' || data.isElective === true || data.isElective === 'TRUE',
          sharedWith: data.sharedWith ? data.sharedWith.trim() : ''
        };
        results.push(cleanData);
      })
      .on('end', async () => {
        try {
          // FORCE CLEAR - Delete all old data
          console.log('\n🧹 Clearing old data...');
          await Timetable.deleteMany({});
          await Course.deleteMany({});
          console.log('✅ Old data cleared');
          
          // Insert new courses
          console.log('📝 Inserting new courses...');
          await Course.insertMany(results);
          console.log('✅ Courses inserted');
          
          fs.unlinkSync(req.file.path);
          
          console.log('\n=== Uploaded Courses Distribution ===');
          console.log(`Total courses: ${results.length}`);
          console.log(`semesterHalf='0' (Both halves): ${results.filter(c => c.semesterHalf === '0').length}`);
          console.log(`semesterHalf='1' (First half only): ${results.filter(c => c.semesterHalf === '1').length}`);
          console.log(`semesterHalf='2' (Second half only): ${results.filter(c => c.semesterHalf === '2').length}`);
          console.log(`Elective courses: ${results.filter(c => c.isElective).length}`);
          console.log(`Cross-branch courses: ${results.filter(c => c.sharedWith).length}`);
          
          // Check if we have faculty and rooms data
          const facultyCount = await Faculty.countDocuments();
          const roomsCount = await Room.countDocuments();
          
          if (facultyCount > 0 && roomsCount > 0) {
            console.log('\n⏱️  Auto-generating new timetable...');
            const timetables = await generateTimetableWithSemesterSplit(
              await Course.find(),
              await Faculty.find(),
              await Room.find()
            );
            
            // FORCE DELETE old timetables first
            await Timetable.deleteMany({});
            console.log('✅ Old timetables cleared');
            
            // Insert new ones
            await Timetable.insertMany(timetables);
            console.log(`✅ New timetable generated with ${timetables.length} entries\n`);
            
            res.json({ 
              message: '✅ Courses uploaded and timetable regenerated successfully', 
              count: results.length,
              timetableEntries: timetables.length,
              firstHalf: timetables.filter(t => t.semesterHalf === 'First_Half').length,
              secondHalf: timetables.filter(t => t.semesterHalf === 'Second_Half').length
            });
          } else {
            res.json({ 
              message: '✅ Courses uploaded successfully', 
              count: results.length,
              note: '⚠️ Timetable not generated - missing faculty or rooms data'
            });
          }
        } catch (dbError) {
          console.error('Database error:', dbError);
          res.status(500).json({ error: dbError.message });
        }
      });
  } catch (error) {
    console.error('Error uploading courses:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/force-clear', async (req, res) => {
  try {
    console.log('🧹 Starting force clear...');
    
    // Drop entire collections
    await Timetable.collection.drop().catch(() => {});
    await Course.collection.drop().catch(() => {});
    await Faculty.collection.drop().catch(() => {});
    await Room.collection.drop().catch(() => {});
    
    console.log('✅ All collections dropped');
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial; text-align: center; padding: 50px; background: #f0f0f0; }
          .success { color: green; font-size: 20px; margin: 20px 0; }
          .btn { padding: 15px 30px; background: #667eea; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; }
          .btn:hover { background: #764ba2; }
        </style>
      </head>
      <body>
        <h1>🧹 Database Force Clear Complete</h1>
        <p class="success">✅ All collections have been dropped and recreated</p>
        <p>The database is now completely empty and ready for fresh data.</p>
        <button class="btn" onclick="window.location.href='/'">← Go Back to Upload</button>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error: ' + error.message);
  }
});

app.post('/upload/faculty', upload.single('file'), async (req, res) => {
  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (data) => results.push(data))
    .on('end', async () => {
      await Faculty.deleteMany({});
      await Faculty.insertMany(results);
      fs.unlinkSync(req.file.path);
      res.json({ message: 'Faculty uploaded successfully', count: results.length });
    });
});

app.post('/upload/rooms', upload.single('file'), async (req, res) => {
  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (data) => results.push(data))
    .on('end', async () => {
      await Room.deleteMany({});
      await Room.insertMany(results);
      fs.unlinkSync(req.file.path);
      res.json({ message: 'Rooms uploaded successfully', count: results.length });
    });
});

app.post('/generate', async (req, res) => {
  try {
    const courses = await Course.find();
    const faculty = await Faculty.find();
    const rooms = await Room.find();

    if (courses.length === 0 || faculty.length === 0 || rooms.length === 0) {
      return res.json({ error: 'Please upload all required data first' });
    }

    const timetables = await generateTimetableWithSemesterSplit(courses, faculty, rooms);
    
    await Timetable.deleteMany({});
    await Timetable.insertMany(timetables);

    res.json({ 
      message: 'Timetables generated successfully', 
      entries: timetables.length,
      firstHalf: timetables.filter(t => t.semesterHalf === 'First_Half').length,
      secondHalf: timetables.filter(t => t.semesterHalf === 'Second_Half').length
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get('/view', async (req, res) => {
  try {
    const timetable = await Timetable.find().sort({ branch: 1, year: 1, section: 1, semesterHalf: 1, day: 1 });
    
    const latestEntry = await Timetable.findOne().sort({ generatedAt: -1 });
    const lastGenerated = latestEntry ? latestEntry.generatedAt : null;
    
    const groupedByBranchYearSection = {};
    
    timetable.forEach(entry => {
      if (!entry.branch || !entry.year) return;
      
      const key = `${entry.branch}-Year${entry.year}-${entry.section || 'ALL'}-${entry.semesterHalf}`;
      
      if (!groupedByBranchYearSection[key]) {
        groupedByBranchYearSection[key] = {
          branch: entry.branch,
          year: entry.year,
          section: entry.section || 'ALL',
          semesterHalf: entry.semesterHalf,
          entries: []
        };
      }
      groupedByBranchYearSection[key].entries.push(entry);
    });
    
    res.render('timetable', { 
      timetable, 
      days, 
      timeSlots, 
      groupedByBranchYear: groupedByBranchYearSection,
      lastGenerated: lastGenerated
    });
  } catch (error) {
    console.error('Error in /view route:', error);
    res.render('timetable', { 
      timetable: [], 
      days, 
      timeSlots, 
      groupedByBranchYear: {},
      lastGenerated: null
    });
  }
});

app.get('/view-faculty', async (req, res) => {
  try {
    const timetable = await Timetable.find().sort({ faculty: 1, semesterHalf: 1, day: 1 });
    
    const facultyTimetables = {};
    
    timetable.forEach(entry => {
      if (!entry.faculty) return;
      
      const faculties = entry.faculty.split('/').map(f => f.trim());
      
      faculties.forEach(faculty => {
        if (!facultyTimetables[faculty]) {
          facultyTimetables[faculty] = {
            name: faculty,
            First_Half: [],
            Second_Half: []
          };
        }
        
        facultyTimetables[faculty][entry.semesterHalf].push(entry);
      });
    });
    
    res.render('faculty-timetable', { 
      facultyTimetables, 
      days, 
      timeSlots 
    });
  } catch (error) {
    console.error('Error in /view-faculty route:', error);
    res.render('faculty-timetable', { 
      facultyTimetables: {}, 
      days, 
      timeSlots 
    });
  }
});

app.get('/download', async (req, res) => {
  const timetable = await Timetable.find().sort({ branch: 1, year: 1, section: 1, semesterHalf: 1, day: 1 });
  
  let csvContent = 'Branch,Year,Section,Semester Half,Day,Time Slot,Course,Faculty,Room,Type,Is Shared,Shared With\n';
  timetable.forEach(entry => {
    csvContent += `${entry.branch},${entry.year},${entry.section || 'ALL'},${entry.semesterHalf},${entry.day},${entry.timeSlot},${entry.course},${entry.faculty},${entry.room},${entry.type},${entry.isShared || false},${entry.sharedWith || ''}\n`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=timetable.csv');
  res.send(csvContent);
});

app.get('/download-faculty', async (req, res) => {
  const timetable = await Timetable.find().sort({ faculty: 1, semesterHalf: 1, day: 1 });
  
  let csvContent = 'Faculty,Semester Half,Day,Time Slot,Course,Branch,Year,Section,Room,Type\n';
  
  const facultyEntries = [];
  timetable.forEach(entry => {
    if (!entry.faculty) return;
    
    const faculties = entry.faculty.split('/').map(f => f.trim());
    faculties.forEach(faculty => {
      facultyEntries.push({
        faculty,
        semesterHalf: entry.semesterHalf,
        day: entry.day,
        timeSlot: entry.timeSlot,
        course: entry.course,
        branch: entry.branch,
        year: entry.year,
        section: entry.section || 'ALL',
        room: entry.room,
        type: entry.type
      });
    });
  });
  
  facultyEntries.sort((a, b) => {
    if (a.faculty !== b.faculty) return a.faculty.localeCompare(b.faculty);
    if (a.semesterHalf !== b.semesterHalf) return a.semesterHalf.localeCompare(b.semesterHalf);
    return a.day.localeCompare(b.day);
  });
  
  facultyEntries.forEach(entry => {
    csvContent += `${entry.faculty},${entry.semesterHalf},${entry.day},${entry.timeSlot},${entry.course},${entry.branch},${entry.year},${entry.section},${entry.room},${entry.type}\n`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=faculty-timetable.csv');
  res.send(csvContent);
});

// MAIN GENERATION FUNCTION with Pre/Post Midsem Split
async function generateTimetableWithSemesterSplit(courses, faculty, rooms) {
  const allTimetables = [];
  
  console.log('\n=== Starting Timetable Generation ===');
  console.log(`Total Courses: ${courses.length}`);
  
  // Separate courses by semester half
  const firstHalfOnlyCourses = courses.filter(c => String(c.semesterHalf) === '1');
  const secondHalfOnlyCourses = courses.filter(c => String(c.semesterHalf) === '2');
  const bothHalvesCourses = courses.filter(c => String(c.semesterHalf) === '0');
  
  console.log(`First Half Only: ${firstHalfOnlyCourses.length}`);
  console.log(`Second Half Only: ${secondHalfOnlyCourses.length}`);
  console.log(`Both Halves: ${bothHalvesCourses.length}`);
  
  // Generate First Half timetable
  const firstHalfCourses = [...bothHalvesCourses, ...firstHalfOnlyCourses];
  console.log(`\nGenerating First Half with ${firstHalfCourses.length} courses`);
  const firstHalfTimetable = await generateTimetableForHalf(firstHalfCourses, faculty, rooms, 'First_Half');
  allTimetables.push(...firstHalfTimetable);
  
  // Generate Second Half timetable
  const secondHalfCourses = [...bothHalvesCourses, ...secondHalfOnlyCourses];
  console.log(`\nGenerating Second Half with ${secondHalfCourses.length} courses`);
  const secondHalfTimetable = await generateTimetableForHalf(secondHalfCourses, faculty, rooms, 'Second_Half');
  allTimetables.push(...secondHalfTimetable);
  
  console.log(`\n=== Generation Complete ===`);
  console.log(`First Half: ${firstHalfTimetable.length} entries`);
  console.log(`Second Half: ${secondHalfTimetable.length} entries`);
  console.log(`Total: ${allTimetables.length} entries`);
  
  return allTimetables;
}

// ENHANCED: Generate timetable for one semester half with elective priority and cross-branch scheduling
async function generateTimetableForHalf(courses, faculty, rooms, semesterHalf) {
  const timetable = [];
  const facultySchedule = {};
  const roomSchedule = {};
  const branchYearSectionSchedule = {};
  const courseSchedule = {};
  const assignedCourseIds = new Set();

  // Filter out 'ALL' sections when specific sections exist
  const validCourses = filterValidCourses(courses);

  // Separate electives and regular courses
  const electiveCourses = validCourses.filter(c => c.isElective);
  const regularCourses = validCourses.filter(c => !c.isElective);

  console.log(`\n${semesterHalf} - Electives: ${electiveCourses.length}, Regular: ${regularCourses.length}`);

  // Get slot combinations
  const lecture90Combinations = findSlotsForDuration(90);
  const tutorial60Combinations = findSlotsForDuration(60);
  const lab120Combinations = findSlotsForDuration(120);

  // PHASE 1: Schedule ALL ELECTIVES in synchronized time slots (ALL YEAR'S ELECTIVES AT SAME TIME)
  console.log('\n=== PHASE 1: Scheduling Electives (Synchronized) ===');
  await scheduleElectivesSynchronized(
    electiveCourses,
    branchYearSectionSchedule,
    courseSchedule,
    assignedCourseIds,
    facultySchedule,
    roomSchedule,
    rooms,
    timetable,
    semesterHalf,
    lecture90Combinations,
    tutorial60Combinations
  );

  // PHASE 2: Schedule REGULAR courses (with cross-branch support)
  console.log('\n=== PHASE 2: Scheduling Regular Courses ===');
  await scheduleCoursesWithPriority(
    regularCourses,
    branchYearSectionSchedule,
    courseSchedule,
    assignedCourseIds,
    facultySchedule,
    roomSchedule,
    rooms,
    timetable,
    semesterHalf,
    lecture90Combinations,
    tutorial60Combinations,
    lab120Combinations,
    'REGULAR'
  );

  return timetable;
}



function findCommonSlotForAllElectives(
  courses,
  session,
  affectedKeys,
  branchYearSectionSchedule,
  facultySchedule,
  roomSchedule,
  courseSchedule,
  semesterHalf
) {
  // Try each day
  for (const day of days) {
    // Try each combination
    for (const combination of session.combinations) {
      if (!combination) continue;

      const slotsToUse = combination.slots;
      let isValidSlot = true;

      // Check if this slot works for ALL courses
      for (const course of courses) {
        if (assignedCourseIds && assignedCourseIds.has(course._id.toString())) {
          continue; // Skip already assigned
        }

        const section = course.section || 'ALL';
        const key = `${course.branch}-${course.year}-${section}`;
        const courseKey = `${key}-${course.code}-${semesterHalf}`;

        // Check if course already scheduled on this day
        if (courseSchedule[courseKey] && courseSchedule[courseKey].includes(day)) {
          isValidSlot = false;
          break;
        }

        // Check all slots for conflicts
        for (const slot of slotsToUse) {
          // Check faculty availability
          const facultyKey = `${course.faculty}-${day}-${slot}-${semesterHalf}`;
          if (facultySchedule[facultyKey]) {
            isValidSlot = false;
            break;
          }

          // Check student schedule (branch-year-section availability)
          if (branchYearSectionSchedule[key] && branchYearSectionSchedule[key][day] && branchYearSectionSchedule[key][day][slot]) {
            isValidSlot = false;
            break;
          }
        }

        if (!isValidSlot) break;
      }

      if (isValidSlot) {
        return { day, slots: slotsToUse };
      }
    }
  }

  return null;
}

// NEW: Backtracking function for elective scheduling
// ============================================================
// CLEAN ELECTIVE SCHEDULING - REPLACE BOTH FUNCTIONS
// ============================================================

// Single unified function - NO DUPLICATES

async function scheduleElectiveIndividually(
  elective, branchKey, section, session, preferredSlots,
  branchYearSectionSchedule, facultySchedule, roomSchedule,
  rooms, timetable, semesterHalf, courseSchedule, assignedCourseIds
) {
  const classrooms = rooms.filter(r => (r.type || '').toLowerCase().includes('class'));
  const roomsToCheck = classrooms.length > 0 ? classrooms : rooms;
  
  // Try all possible slot combinations
  for (const combination of session.combinations) {
    const slotsToUse = combination.slots;
    
    for (const day of days) {
      for (const room of roomsToCheck) {
        let canSchedule = true;
        
        // Check student availability
        for (const slot of slotsToUse) {
          if (branchYearSectionSchedule[branchKey][day][slot]) {
            canSchedule = false;
            break;
          }
        }
        
        if (!canSchedule) continue;
        
        // Check faculty availability
        for (const slot of slotsToUse) {
          const facultyKey = `${elective.faculty}-${day}-${slot}-${semesterHalf}`;
          if (facultySchedule[facultyKey]) {
            canSchedule = false;
            break;
          }
        }
        
        if (!canSchedule) continue;
        
        // Check room availability
        for (const slot of slotsToUse) {
          const roomKey = `${room.number}-${day}-${slot}-${semesterHalf}`;
          if (roomSchedule[roomKey]) {
            canSchedule = false;
            break;
          }
        }
        
        if (canSchedule) {
          // Schedule it!
          const courseKey = `${branchKey}-${elective.code}-${semesterHalf}`;
          if (!courseSchedule[courseKey]) {
            courseSchedule[courseKey] = [];
          }
          if (!courseSchedule[courseKey].includes(day)) {
            courseSchedule[courseKey].push(day);
          }
          
          slotsToUse.forEach((slot, idx) => {
            const sessionLabel = session.type === 'Tutorial' ? 
              'Tutorial' : `Lecture ${session.sessionNum}`;
            
            let courseName = `${elective.name} - ${sessionLabel}`;
            if (slotsToUse.length > 1) {
              courseName += ` (${idx + 1}/${slotsToUse.length})`;
            }

            timetable.push({
              day,
              timeSlot: slot,
              course: courseName,
              faculty: elective.faculty,
              room: room.number,
              type: session.type,
              branch: elective.branch,
              section: section,
              year: parseInt(elective.year),
              semesterHalf: semesterHalf,
              isShared: false,
              sharedWith: ''
            });

            facultySchedule[`${elective.faculty}-${day}-${slot}-${semesterHalf}`] = true;
            roomSchedule[`${room.number}-${day}-${slot}-${semesterHalf}`] = true;
            branchYearSectionSchedule[branchKey][day][slot] = true;
          });

          assignedCourseIds.add(elective._id.toString());
          return true;
        }
      }
    }
  }
  
  return false;
}

async function scheduleElectivesSynchronized(
  electiveCourses,
  branchYearSectionSchedule,
  courseSchedule,
  assignedCourseIds,
  facultySchedule,
  roomSchedule,
  rooms,
  timetable,
  semesterHalf,
  lecture90Combinations,
  tutorial60Combinations
) {
  if (electiveCourses.length === 0) {
    console.log('No electives to schedule');
    return;
  }

  // Group electives by YEAR ONLY (cross-branch)
  const electivesByYear = {};
  electiveCourses.forEach(course => {
    const year = course.year;
    if (!electivesByYear[year]) {
      electivesByYear[year] = [];
    }
    electivesByYear[year].push(course);
  });

  console.log(`\nGrouping electives by year (cross-branch):`);
  Object.keys(electivesByYear).forEach(year => {
    const electives = electivesByYear[year];
    const branches = [...new Set(electives.map(e => e.branch))];
    console.log(`  Year ${year}: ${electives.length} electives across branches: ${branches.join(', ')}`);
  });

  // Schedule each year's electives together
  for (const [year, yearElectives] of Object.entries(electivesByYear)) {
    console.log(`\n  === Scheduling Year ${year} Electives (ALL ${yearElectives.length} courses at SAME TIME) ===`);

    const sessionsNeeded = [
      { type: 'Lecture', sessionNum: 1, combinations: lecture90Combinations },
      { type: 'Lecture', sessionNum: 2, combinations: lecture90Combinations },
      { type: 'Tutorial', sessionNum: 1, combinations: tutorial60Combinations }
    ];

    // Schedule each session type (ALL year electives at SAME TIME, DIFFERENT ROOMS)
    for (const session of sessionsNeeded) {
      let scheduled = false;
      let attempts = 0;
      const maxAttempts = 3000;

      while (!scheduled && attempts < maxAttempts) {
        const day = days[Math.floor(Math.random() * days.length)];
        const combination = session.combinations[Math.floor(Math.random() * session.combinations.length)];
        
        if (!combination) {
          attempts++;
          continue;
        }

        const slotsToUse = combination.slots;

        // Try to assign DIFFERENT rooms and check conflicts for ALL electives
        const assignments = [];
        const usedRooms = new Set();
        let allCanBeScheduled = true;

        for (const elective of yearElectives) {
          const section = elective.section || 'ALL';
          const branchKey = `${elective.branch}-${elective.year}-${section}`;
          
          // Initialize schedule if needed
          if (!branchYearSectionSchedule[branchKey]) {
            branchYearSectionSchedule[branchKey] = {};
            days.forEach(d => {
              branchYearSectionSchedule[branchKey][d] = {};
            });
          }

          // Check if students from this branch-section are available
          let studentsAvailable = true;
          for (const slot of slotsToUse) {
            if (branchYearSectionSchedule[branchKey][day][slot]) {
              studentsAvailable = false;
              break;
            }
          }

          if (!studentsAvailable) {
            allCanBeScheduled = false;
            break;
          }

          // Check faculty availability
          let facultyAvailable = true;
          for (const slot of slotsToUse) {
            const facultyKey = `${elective.faculty}-${day}-${slot}-${semesterHalf}`;
            if (facultySchedule[facultyKey]) {
              facultyAvailable = false;
              break;
            }
          }

          if (!facultyAvailable) {
            allCanBeScheduled = false;
            break;
          }

          // Find a UNIQUE room for this elective
          const classrooms = rooms.filter(r => (r.type || '').toLowerCase().includes('class'));
          const roomsToCheck = classrooms.length > 0 ? classrooms : rooms;
          
          let foundRoom = null;
          for (const room of roomsToCheck) {
            // Must be different from other electives in this slot
            if (usedRooms.has(room.number)) continue;

            // Check room availability
            let roomAvailable = true;
            for (const slot of slotsToUse) {
              const roomKey = `${room.number}-${day}-${slot}-${semesterHalf}`;
              if (roomSchedule[roomKey]) {
                roomAvailable = false;
                break;
              }
            }

            if (roomAvailable) {
              foundRoom = room;
              usedRooms.add(room.number);
              break;
            }
          }

          if (!foundRoom) {
            allCanBeScheduled = false;
            break;
          }

          assignments.push({
            elective: elective,
            room: foundRoom,
            branchKey: branchKey,
            section: section
          });
        }

        // If ALL electives can be scheduled, schedule them all at SAME TIME!
        if (allCanBeScheduled && assignments.length === yearElectives.length) {
          assignments.forEach(({ elective, room, branchKey, section }) => {
            const courseKey = `${branchKey}-${elective.code}-${semesterHalf}`;
            
            if (!courseSchedule[courseKey]) {
              courseSchedule[courseKey] = [];
            }
            if (!courseSchedule[courseKey].includes(day)) {
              courseSchedule[courseKey].push(day);
            }
            
            slotsToUse.forEach((slot, idx) => {
              const sessionLabel = session.type === 'Tutorial' ? 
                'Tutorial' : `Lecture ${session.sessionNum}`;
              
              let courseName = `${elective.name} - ${sessionLabel}`;
              if (slotsToUse.length > 1) {
                courseName += ` (${idx + 1}/${slotsToUse.length})`;
              }

              timetable.push({
                day,
                timeSlot: slot,
                course: courseName,
                faculty: elective.faculty,
                room: room.number,
                type: session.type,
                branch: elective.branch,
                section: section,
                year: parseInt(elective.year),
                semesterHalf: semesterHalf,
                isShared: true, // Cross-branch elective
                sharedWith: `Year ${year} Cross-Branch Elective`
              });

              // Mark resources as busy
              facultySchedule[`${elective.faculty}-${day}-${slot}-${semesterHalf}`] = true;
              roomSchedule[`${room.number}-${day}-${slot}-${semesterHalf}`] = true;
              branchYearSectionSchedule[branchKey][day][slot] = true;
            });

            assignedCourseIds.add(elective._id.toString());
          });

          // Log success with detailed room assignments
          console.log(`\n    ✓ ${session.type} ${session.sessionNum || ''} on ${day} (${slotsToUse[0]}):`);
          assignments.forEach(a => {
            console.log(`      - ${a.elective.code} (${a.elective.branch}): Room ${a.room.number} [Faculty: ${a.elective.faculty}]`);
          });
          console.log(`      🎯 ALL ${assignments.length} ELECTIVES AT SAME TIME - Students can choose!`);
          
          scheduled = true;
        }

        attempts++;
      }

      if (!scheduled) {
        console.log(`\n    ✗✗✗ FAILED: ${session.type} ${session.sessionNum || ''} after ${maxAttempts} attempts`);
        console.log(`    Required: ${yearElectives.length} different rooms, all faculty available, all students free`);
        console.log(`    Attempting fallback scheduling...`);
        
        // Fallback: Schedule individually
        for (const elective of yearElectives) {
          if (!assignedCourseIds.has(elective._id.toString())) {
            const section = elective.section || 'ALL';
            const branchKey = `${elective.branch}-${elective.year}-${section}`;
            
            const success = await scheduleElectiveIndividually(
              elective, branchKey, section, session, slotsToUse,
              branchYearSectionSchedule, facultySchedule, roomSchedule,
              rooms, timetable, semesterHalf, courseSchedule, assignedCourseIds
            );
            
            if (success) {
              console.log(`      ↳ ${elective.code} (${elective.branch}) scheduled individually`);
            } else {
              console.log(`      ✗ ${elective.code} (${elective.branch}) could not be scheduled`);
            }
          }
        }
      }
    }
  }

  // Final Summary
  const totalElectives = electiveCourses.length;
  const scheduledElectives = [...assignedCourseIds].filter(id => {
    return electiveCourses.some(e => e._id.toString() === id);
  }).length;
  const successRate = Math.round(scheduledElectives/totalElectives*100);
  
  console.log(`\n  ========================================`);
  console.log(`  📊 ELECTIVES SUMMARY:`);
  console.log(`     Scheduled: ${scheduledElectives}/${totalElectives} (${successRate}%)`);
  
  if (successRate === 100) {
    console.log(`     ✅ SUCCESS! All electives scheduled!`);
  } else {
    console.log(`     ⚠️  ${totalElectives - scheduledElectives} electives failed`);
    console.log(`     💡 Consider: More rooms, different time slots, or fewer conflicts`);
  }
  console.log(`  ========================================\n`);
}


// NEW: Schedule all electives of same year at same time slot
async function scheduleElectivesCoordinated(
  courses,
  branchYearSectionSchedule,
  courseSchedule,
  assignedCourseIds,
  facultySchedule,
  roomSchedule,
  rooms,
  timetable,
  semesterHalf,
  lecture90Combinations,
  tutorial60Combinations
) {
  // Group electives by YEAR only
  const electivesByYear = {};
  courses.forEach(course => {
    if (!course.year) return;
    const year = course.year;
    if (!electivesByYear[year]) {
      electivesByYear[year] = [];
    }
    electivesByYear[year].push(course);
  });

  console.log(`ELECTIVE - Processing ${Object.keys(electivesByYear).length} years`);

  // For each year
  for (const year of Object.keys(electivesByYear).sort()) {
    const yearElectives = electivesByYear[year];
    console.log(`\n  Year ${year}: ${yearElectives.length} elective courses`);

    // Initialize schedules
    yearElectives.forEach(course => {
      const section = course.section || 'ALL';
      const key = `${course.branch}-${course.year}-${section}`;
      if (!branchYearSectionSchedule[key]) {
        branchYearSectionSchedule[key] = {};
        days.forEach(d => branchYearSectionSchedule[key][d] = {});
      }
    });

    // Sessions for this year's electives
    const sessionsNeeded = [
      { type: 'Lecture', sessionNum: 1, combinations: lecture90Combinations },
      { type: 'Lecture', sessionNum: 2, combinations: lecture90Combinations },
      { type: 'Tutorial', sessionNum: null, combinations: tutorial60Combinations }
    ];

    // For each session type, find ONE common slot for ALL electives
    for (const session of sessionsNeeded) {
      const foundSlot = findCommonSlotForAllElectives(
        yearElectives,
        session,
        branchYearSectionSchedule,
        facultySchedule,
        roomSchedule,
        courseSchedule,
        assignedCourseIds,
        semesterHalf
      );

      if (!foundSlot) {
        console.log(`    ✗ No common slot for Year ${year} ${session.type} ${session.sessionNum || ''}`);
        continue;
      }

      console.log(`    📅 Year ${year} ${session.type}: ${foundSlot.day} ${foundSlot.slots[0]}`);

      // Schedule ALL electives at this slot
      const classrooms = rooms.filter(r => (r.type || '').toLowerCase().includes('class'));
      let scheduledCount = 0;

      for (const course of yearElectives) {
        if (assignedCourseIds.has(course._id.toString())) continue;

        const section = course.section || 'ALL';
        const key = `${course.branch}-${course.year}-${section}`;
        const courseKey = `${key}-${course.code}-${semesterHalf}`;

        if (!courseSchedule[courseKey]) {
          courseSchedule[courseKey] = [];
        }

        const room = classrooms[Math.floor(Math.random() * classrooms.length)];

        // Schedule each slot
        foundSlot.slots.forEach((slot, idx) => {
          const sessionLabel = session.type === 'Tutorial' ? 'Tutorial' : `Lecture ${session.sessionNum}`;
          let courseName = `${course.name} - ${sessionLabel}`;
          if (foundSlot.slots.length > 1) {
            courseName += ` (${idx + 1}/${foundSlot.slots.length})`;
          }

          timetable.push({
            day: foundSlot.day,
            timeSlot: slot,
            course: courseName,
            faculty: course.faculty,
            room: room.number,
            type: session.type,
            branch: course.branch,
            section: section,
            year: parseInt(course.year),
            semesterHalf: semesterHalf,
            isShared: false,
            sharedWith: `Year ${year} Electives`
          });

          facultySchedule[`${course.faculty}-${foundSlot.day}-${slot}-${semesterHalf}`] = true;
          roomSchedule[`${room.number}-${foundSlot.day}-${slot}-${semesterHalf}`] = true;
          branchYearSectionSchedule[key][foundSlot.day][slot] = true;
        });

        if (!courseSchedule[courseKey].includes(foundSlot.day)) {
          courseSchedule[courseKey].push(foundSlot.day);
        }

        assignedCourseIds.add(course._id.toString());
        scheduledCount++;
      }

      console.log(`    ✓ Scheduled ${scheduledCount} electives`);
    }
  }
}

// Find ONE slot that works for ALL electives of a year
function findCommonSlotForAllElectives(
  courses,
  session,
  branchYearSectionSchedule,
  facultySchedule,
  roomSchedule,
  courseSchedule,
  assignedCourseIds,
  semesterHalf
) {
  SLOT_SEARCH: for (const day of days) {
    for (const combination of session.combinations) {
      if (!combination) continue;

      const slots = combination.slots;
      let isValid = true;

      // Check if this slot works for EVERY elective
      for (const course of courses) {
        if (assignedCourseIds.has(course._id.toString())) continue;

        const section = course.section || 'ALL';
        const key = `${course.branch}-${course.year}-${section}`;
        const courseKey = `${key}-${course.code}-${semesterHalf}`;

        // Already scheduled on this day?
        if (courseSchedule[courseKey] && courseSchedule[courseKey].includes(day)) {
          isValid = false;
          break;
        }

        // Check all slots for conflicts
        for (const slot of slots) {
          // Faculty conflict?
          if (facultySchedule[`${course.faculty}-${day}-${slot}-${semesterHalf}`]) {
            isValid = false;
            break;
          }

          // Student schedule conflict?
          if (branchYearSectionSchedule[key] && branchYearSectionSchedule[key][day] && branchYearSectionSchedule[key][day][slot]) {
            isValid = false;
            break;
          }
        }
        if (!isValid) break;
      }

      if (isValid) {
        return { day, slots };
      }
    }
  }

  return null;
}

// NEW: Check if a slot works for all electives in a basket


// NEW: Schedule courses with cross-branch logic
async function scheduleCoursesWithPriority(
  courses,
  branchYearSectionSchedule,
  courseSchedule,
  assignedCourseIds,
  facultySchedule,
  roomSchedule,
  rooms,
  timetable,
  semesterHalf,
  lecture90Combinations,
  tutorial60Combinations,
  lab120Combinations,
  phase
) {
  // For electives, use the new coordinated scheduling
  if (phase === 'ELECTIVE') {
    return await scheduleElectivesCoordinated(
      courses,
      branchYearSectionSchedule,
      courseSchedule,
      assignedCourseIds,
      facultySchedule,
      roomSchedule,
      rooms,
      timetable,
      semesterHalf,
      lecture90Combinations,
      tutorial60Combinations,
      lab120Combinations
    );
  }

  // Regular course scheduling remains unchanged
  const coursesByBranchYearSection = {};
  courses.forEach(course => {
    if (!course.branch || !course.year) return;
    
    const section = course.section || 'ALL';
    const key = `${course.branch}-${course.year}-${section}`;
    
    if (!coursesByBranchYearSection[key]) {
      coursesByBranchYearSection[key] = [];
    }
    coursesByBranchYearSection[key].push(course);
  });

  console.log(`${phase} - Processing ${Object.keys(coursesByBranchYearSection).length} branch-year-section combinations`);

  Object.keys(coursesByBranchYearSection).sort().forEach(key => {
    const [branch, year, section] = key.split('-');
    const branchSectionCourses = coursesByBranchYearSection[key];
    
    console.log(`\n  ${branch} Year ${year} Section ${section}: ${branchSectionCourses.length} courses`);

    if (!branchYearSectionSchedule[key]) {
      branchYearSectionSchedule[key] = {};
      days.forEach(day => {
        branchYearSectionSchedule[key][day] = {};
      });
    }

    const labCourses = branchSectionCourses.filter(c => (c.type || '').toLowerCase().includes('lab'));
    const regularCoursesInSection = branchSectionCourses.filter(c => !(c.type || '').toLowerCase().includes('lab'));

    regularCoursesInSection.forEach(course => {
      if (assignedCourseIds.has(course._id.toString())) {
        return;
      }

      const courseKey = `${key}-${course.code}-${semesterHalf}`;
      courseSchedule[courseKey] = [];

      const partner = findPartnerCourse(course, courses, assignedCourseIds);
      const coursesToSchedule = partner ? [course, partner] : [course];

      if (partner) {
        console.log(`    🔗 Cross-scheduling: ${course.code} (${course.branch}) with ${partner.branch}`);
        assignedCourseIds.add(partner._id.toString());
        
        const partnerSection = partner.section || 'ALL';
        const partnerKey = `${partner.branch}-${partner.year}-${partnerSection}`;
        if (!branchYearSectionSchedule[partnerKey]) {
          branchYearSectionSchedule[partnerKey] = {};
          days.forEach(day => {
            branchYearSectionSchedule[partnerKey][day] = {};
          });
        }
        courseSchedule[`${partnerKey}-${partner.code}-${semesterHalf}`] = [];
      }

      assignedCourseIds.add(course._id.toString());

      const sessionsNeeded = [
        { type: 'Lecture', duration: 90, sessionNum: 1, combinations: lecture90Combinations },
        { type: 'Lecture', duration: 90, sessionNum: 2, combinations: lecture90Combinations },
        { type: 'Tutorial', duration: 60, sessionNum: 1, combinations: tutorial60Combinations }
      ];

      sessionsNeeded.forEach(session => {
        const assigned = scheduleSessionWithCrossBranch(
          coursesToSchedule,
          session,
          key,
          section,
          courseKey,
          branchYearSectionSchedule,
          facultySchedule,
          roomSchedule,
          courseSchedule,
          rooms,
          timetable,
          semesterHalf
        );
        
        if (assigned) {
          const label = partner ? 
            `${course.code} (${course.branch}+${partner.branch})` : 
            course.code;
          console.log(`    ✓ ${label} ${session.type} ${session.sessionNum || ''}`);
        } else {
          console.log(`    ✗ Failed: ${course.code} ${session.type} ${session.sessionNum || ''}`);
        }
      });
    });

    labCourses.forEach(course => {
      if (assignedCourseIds.has(course._id.toString())) {
        return;
      }

      assignedCourseIds.add(course._id.toString());

      const assigned = scheduleLabSession(
        course,
        key,
        section,
        branchYearSectionSchedule,
        facultySchedule,
        roomSchedule,
        rooms,
        timetable,
        semesterHalf,
        lab120Combinations
      );
      
      if (assigned) {
        console.log(`    ✓ ${course.code} Lab`);
      } else {
        console.log(`    ✗ Failed: ${course.code} Lab`);
      }
    });
  });
}

// Filter out 'ALL' sections when specific sections exist
function filterValidCourses(courses) {
  const branchYearMap = {};
  
  courses.forEach(course => {
    const key = `${course.branch}-${course.year}`;
    if (!branchYearMap[key]) {
      branchYearMap[key] = { hasSpecific: false, courses: [] };
    }
    
    const section = course.section || 'ALL';
    if (section !== 'ALL') {
      branchYearMap[key].hasSpecific = true;
    }
    branchYearMap[key].courses.push(course);
  });
  
  const validCourses = [];
  Object.values(branchYearMap).forEach(group => {
    if (group.hasSpecific) {
      validCourses.push(...group.courses.filter(c => (c.section || 'ALL') !== 'ALL'));
    } else {
      validCourses.push(...group.courses);
    }
  });
  
  return validCourses;
}

// ENHANCED: Schedule session with cross-branch support
function scheduleSessionWithCrossBranch(
  coursesToSchedule,
  session,
  key,
  section,
  courseKey,
  branchYearSectionSchedule,
  facultySchedule,
  roomSchedule,
  courseSchedule,
  rooms,
  timetable,
  semesterHalf
) {
  const primaryCourse = coursesToSchedule[0];
  const hasPartner = coursesToSchedule.length > 1;

  // Get available days
  const availableDays = days.filter(d => !courseSchedule[courseKey].includes(d));
  if (availableDays.length === 0) return false;

  // Try each available day
  for (const day of availableDays) {
    // Try each combination
    for (const combination of session.combinations) {
      if (!combination) continue;

      const slotsToUse = combination.slots;
      
      // Select appropriate room
      const classrooms = rooms.filter(r => (r.type || '').toLowerCase().includes('class'));
      const selectedRoom = classrooms.length > 0 ? 
        classrooms[Math.floor(Math.random() * classrooms.length)] : rooms[0];

      // Check conflicts for ALL courses in the group
      let hasConflict = false;
      for (const slot of slotsToUse) {
        const roomKey = `${selectedRoom.number}-${day}-${slot}-${semesterHalf}`;
        
        // Check room availability
        if (roomSchedule[roomKey]) {
          hasConflict = true;
          break;
        }

        // Check each course's constraints
        for (const course of coursesToSchedule) {
          const facultyKey = `${course.faculty}-${day}-${slot}-${semesterHalf}`;
          if (facultySchedule[facultyKey]) {
            hasConflict = true;
            break;
          }

          const branchSection = course.section || 'ALL';
          const branchKey = `${course.branch}-${course.year}-${branchSection}`;
          if (!branchYearSectionSchedule[branchKey]) {
            branchYearSectionSchedule[branchKey] = {};
            days.forEach(d => {
              branchYearSectionSchedule[branchKey][d] = {};
            });
          }
          if (branchYearSectionSchedule[branchKey][day][slot]) {
            hasConflict = true;
            break;
          }
        }

        if (hasConflict) break;
      }

      if (!hasConflict) {
        // Schedule all slots for all courses
        slotsToUse.forEach((slot, idx) => {
          const sessionLabel = session.type === 'Tutorial' ? 
            'Tutorial' : `Lecture ${session.sessionNum}`;
          
          coursesToSchedule.forEach(course => {
            let courseName = `${course.name} - ${sessionLabel}`;
            if (slotsToUse.length > 1) {
              courseName += ` (${idx + 1}/${slotsToUse.length})`;
            }

            const branchSection = course.section || 'ALL';
            const branchKey = `${course.branch}-${course.year}-${branchSection}`;

            timetable.push({
              day,
              timeSlot: slot,
              course: courseName,
              faculty: course.faculty,
              room: selectedRoom.number,
              type: session.type,
              branch: course.branch,
              section: branchSection,
              year: parseInt(course.year),
              semesterHalf: semesterHalf,
              isShared: hasPartner,
              sharedWith: hasPartner ? coursesToSchedule.map(c => `${c.branch}-${c.section}`).join(', ') : ''
            });

            // Mark resources as busy
            facultySchedule[`${course.faculty}-${day}-${slot}-${semesterHalf}`] = true;
            branchYearSectionSchedule[branchKey][day][slot] = true;
            
            // Track scheduled day
            const trackingKey = `${branchKey}-${course.code}-${semesterHalf}`;
            if (!courseSchedule[trackingKey]) {
              courseSchedule[trackingKey] = [];
            }
            if (!courseSchedule[trackingKey].includes(day)) {
              courseSchedule[trackingKey].push(day);
            }
          });

          // Mark room as busy (once for all courses)
          roomSchedule[`${selectedRoom.number}-${day}-${slot}-${semesterHalf}`] = true;
        });

        return true; // Successfully scheduled
      }
    }
  }

  return false; // Could not find a valid slot
}
// NEW: Find a time slot that works for all electives in a basket

async function scheduleElectivesCoordinated(
  courses,
  branchYearSectionSchedule,
  courseSchedule,
  assignedCourseIds,
  facultySchedule,
  roomSchedule,
  rooms,
  timetable,
  semesterHalf,
  lecture90Combinations,
  tutorial60Combinations,
  lab120Combinations
) {
  // Group electives by year and basket
  const electivesByYearBasket = {};
  
  courses.forEach(course => {
    if (!course.year) return;
    
    const year = course.year;
    const basket = course.basket || 0;
    const key = `Year${year}-Basket${basket}`;
    
    if (!electivesByYearBasket[key]) {
      electivesByYearBasket[key] = {
        year: year,
        basket: basket,
        courses: []
      };
    }
    electivesByYearBasket[key].courses.push(course);
  });

  console.log(`ELECTIVE - Processing ${Object.keys(electivesByYearBasket).length} year-basket combinations`);

  // Process each year-basket group
  Object.keys(electivesByYearBasket).sort().forEach(groupKey => {
    const group = electivesByYearBasket[groupKey];
    console.log(`\n  ${groupKey}: ${group.courses.length} elective courses`);

    // Get all branch-year-section combinations for this year
    const affectedKeys = new Set();
    group.courses.forEach(course => {
      const section = course.section || 'ALL';
      const key = `${course.branch}-${course.year}-${section}`;
      affectedKeys.add(key);
      
      // Initialize schedule if needed
      if (!branchYearSectionSchedule[key]) {
        branchYearSectionSchedule[key] = {};
        days.forEach(day => {
          branchYearSectionSchedule[key][day] = {};
        });
      }
    });

    // Find a common time slot for ALL electives in this basket
    const sessionsNeeded = [
      { type: 'Lecture', duration: 90, sessionNum: 1, combinations: lecture90Combinations },
      { type: 'Lecture', duration: 90, sessionNum: 2, combinations: lecture90Combinations },
      { type: 'Tutorial', duration: 60, sessionNum: 1, combinations: tutorial60Combinations }
    ];

    sessionsNeeded.forEach(session => {
      // Find slots that work for ALL courses in this basket
      const commonSlot = findCommonElectiveSlot(
        group.courses,
        session,
        affectedKeys,
        branchYearSectionSchedule,
        facultySchedule,
        roomSchedule,
        courseSchedule,
        semesterHalf
      );

      if (commonSlot) {
        // Schedule all electives in this basket at the same time
        group.courses.forEach(course => {
          if (assignedCourseIds.has(course._id.toString())) {
            return;
          }

          const section = course.section || 'ALL';
          const key = `${course.branch}-${course.year}-${section}`;
          const courseKey = `${key}-${course.code}-${semesterHalf}`;
          
          if (!courseSchedule[courseKey]) {
            courseSchedule[courseKey] = [];
          }

          assignedCourseIds.add(course._id.toString());

          // Get appropriate room
          const classrooms = rooms.filter(r => (r.type || '').toLowerCase().includes('class'));
          const selectedRoom = classrooms.length > 0 ? 
            classrooms[Math.floor(Math.random() * classrooms.length)] : rooms[0];

          // Schedule all slots
          commonSlot.slots.forEach((slot, idx) => {
            const sessionLabel = session.type === 'Tutorial' ? 
              'Tutorial' : `Lecture ${session.sessionNum}`;
            
            let courseName = `${course.name} - ${sessionLabel}`;
            if (commonSlot.slots.length > 1) {
              courseName += ` (${idx + 1}/${commonSlot.slots.length})`;
            }

            timetable.push({
              day: commonSlot.day,
              timeSlot: slot,
              course: courseName,
              faculty: course.faculty,
              room: selectedRoom.number,
              type: session.type,
              branch: course.branch,
              section: section,
              year: parseInt(course.year),
              semesterHalf: semesterHalf,
              isShared: false,
              sharedWith: `Basket ${group.basket}`
            });

            // Mark resources as busy
            facultySchedule[`${course.faculty}-${commonSlot.day}-${slot}-${semesterHalf}`] = true;
            roomSchedule[`${selectedRoom.number}-${commonSlot.day}-${slot}-${semesterHalf}`] = true;
            branchYearSectionSchedule[key][commonSlot.day][slot] = true;
          });

          // Track scheduled day
          if (!courseSchedule[courseKey].includes(commonSlot.day)) {
            courseSchedule[courseKey].push(commonSlot.day);
          }

          console.log(`    ✓ ${course.code} (${course.branch}) ${session.type} ${session.sessionNum || ''} - ${commonSlot.day}`);
        });
      } else {
        console.log(`    ✗ Failed to find common slot for ${groupKey} ${session.type} ${session.sessionNum || ''}`);
      }
    });
  });
}


// Regular lab scheduling (unchanged)
function scheduleLabSession(
  course,
  key,
  section,
  branchYearSectionSchedule,
  facultySchedule,
  roomSchedule,
  rooms,
  timetable,
  semesterHalf,
  lab120Combinations
) {
  // Try each day
  for (const day of days) {
    // Try each combination
    for (const combination of lab120Combinations) {
      if (!combination) continue;

      const slotsToUse = combination.slots;
      
      const labRooms = rooms.filter(r => (r.type || '').toLowerCase().includes('lab'));
      const selectedRoom = labRooms.length > 0 ? 
        labRooms[Math.floor(Math.random() * labRooms.length)] : rooms[0];

      let hasConflict = false;
      for (const slot of slotsToUse) {
        const facultyKey = `${course.faculty}-${day}-${slot}-${semesterHalf}`;
        const roomKey = `${selectedRoom.number}-${day}-${slot}-${semesterHalf}`;
        
        if (facultySchedule[facultyKey] || roomSchedule[roomKey] || 
            branchYearSectionSchedule[key][day][slot]) {
          hasConflict = true;
          break;
        }
      }

      if (!hasConflict) {
        slotsToUse.forEach((slot, idx) => {
          timetable.push({
            day,
            timeSlot: slot,
            course: `${course.name} (${idx + 1}/${slotsToUse.length})`,
            faculty: course.faculty,
            room: selectedRoom.number,
            type: 'Lab',
            branch: course.branch,
            section: section,
            year: parseInt(course.year),
            semesterHalf: semesterHalf
          });

          facultySchedule[`${course.faculty}-${day}-${slot}-${semesterHalf}`] = true;
          roomSchedule[`${selectedRoom.number}-${day}-${slot}-${semesterHalf}`] = true;
          branchYearSectionSchedule[key][day][slot] = true;
        });

        return true; // Successfully scheduled
      }
    }
  }

  return false; // Could not schedule
}


app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});