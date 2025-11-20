# 🕒 Automated Timetable Generator

The **Automated Timetable Generator** is a backend-driven **MERN stack** project (without React) that creates optimized class schedules automatically.  
It takes course, faculty, and room details as input and generates a **conflict-free weekly timetable** — saving time, reducing human error, and ensuring efficient utilization of resources.

---

## ⚙️ Tech Stack
- **Backend:** Node.js, Express.js  
- **Database:** MongoDB  
- **File Upload**: Multer
- **CSV Parsing**: csv-parser
- **Frontend:** HTML, CSS, EJS  
- **Language:** JavaScript  

---

## Features

- CSV upload for courses, faculty, and rooms
- Automated timetable generation with conflict resolution
- Even distribution of classes across all weekdays
- Color-coded timetable view (Lectures, Labs, Tutorials)
- Export timetable to CSV
- Print-friendly view
- Modern, responsive UI
- Smart room allocation (Labs → Lab rooms, Lectures → Classrooms)
- Consecutive slot allocation for multi-hour classes

---

## 📥 Inputs
The system accepts data through CSV files or forms:

| Input Type | Description |
|-------------|-------------|
| **Courses** | Course code, course name, and type (Lecture/Lab) |
| **Faculty** | Faculty name and available slots |
| **Rooms** | Room name, capacity, and type |

---

**project structure**:
```
timetable-generator/
├── server.js
├── package.json
├── views/
│   ├── index.ejs
│   └── timetable.ejs
├── public/
├── uploads/
└── sample_data/
    ├── sample_courses.csv
    ├── sample_faculty.csv
    └── sample_rooms.csv
```

---

## 🧠 Algorithm Features
The scheduling algorithm applies **constraint-based allocation**:
The timetable generator ensures:
- **Even distribution** of classes across all weekdays
- **No faculty conflicts** (faculty can't be in two places at once)
- **No room conflicts** (rooms can't host two classes simultaneously)
- **Smart room allocation** (Labs get lab rooms, lectures get classrooms)
- **Consecutive slot allocation** for multi-hour classes (labs, workshops)
- **Priority scheduling** (Labs scheduled first as they need more consecutive slots)
- Automatic retry mechanism for difficult-to-place courses
- Distribution statistics logged in console

---

## API Endpoints
- `GET /` - Upload interface
- `POST /upload/courses` - Upload courses CSV
- `POST /upload/faculty` - Upload faculty CSV
- `POST /upload/rooms` - Upload rooms CSV
- `POST /generate` - Generate timetable
- `GET /view` - View generated timetable
- `GET /download` - Download timetable as CSV

---

## Color Coding

- 🔵 **Blue** - Lectures
- 🔴 **Red** - Labs
- 🟢 **Green** - Tutorials

---

🧩 *Future Enhancement:* integrate **Genetic Algorithm** or **Backtracking** for more efficient timetable optimization.
- Export to PDF with custom formatting
- Multi-section support for large classes
- Student group and batch management
- Room capacity validation against class size
- Custom time slot configuration
- Faculty workload balancing
- Drag-and-drop manual adjustments

---

## 📤 Output Generated
- Weekly timetable displayed in a tabular format (by day and slot)  
- Option to **download as CSV or PDF**  
- Cleanly formatted schedule showing course, faculty, and room per slot.

