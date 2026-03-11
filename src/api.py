"""
GeoSecure — Integrated Flask API
=================================
Combines Pre-Disaster (prediction) + During-Disaster (SOS & rescue) phases
Pre-Disaster  → port 5000  →  /api/predict, /api/history, /api/stats
During-Disaster → same port  →  /victim, /admin/dashboard, /api/victim/*, /api/admin/*

Run: python src/api.py
"""

from flask import Flask, render_template, request, jsonify, send_from_directory, redirect, session
from flask_cors import CORS
import pandas as pd
import numpy as np
import requests
import joblib
import sqlite3
import random
import os
import math
from datetime import datetime, timedelta

# ─── CONFIGURATION ────────────────────────────────────────────────────────────
BASE_DIR      = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE_DIR  = os.path.join(BASE_DIR, 'during', 'templates')
STATIC_DIR    = os.path.join(BASE_DIR, 'during', 'static')
MODEL_PATH    = os.path.join(BASE_DIR, 'models', 'geosecure_v1.keras')
SCALER_PATH   = os.path.join(BASE_DIR, 'models', 'scaler.pkl')
DATA_PATH     = os.path.join(BASE_DIR, 'data', 'raw', 'chennai_weather_final.csv')
DATABASE      = os.path.join(BASE_DIR, 'during', 'disaster_management.db')
UPLOAD_FOLDER = os.path.join(BASE_DIR, 'during', 'uploads')

# ─── MODULE 3 — RECOVERY CONFIGURATION ───────────────────────────────────────
RECOVERY_DIR      = os.path.join(BASE_DIR, 'recovery')
RECOVERY_TEMPLATE = os.path.join(RECOVERY_DIR, 'templates')
RECOVERY_STATIC   = os.path.join(RECOVERY_DIR, 'static')
RECOVERY_DB       = os.path.join(RECOVERY_DIR, 'recovery.db')
RECOVERY_UPLOADS  = os.path.join(RECOVERY_DIR, 'uploads')
os.makedirs(RECOVERY_UPLOADS, exist_ok=True)

# Use Jinja2 multi-folder loader so both template dirs work
from jinja2 import ChoiceLoader, FileSystemLoader

app = Flask(
    __name__,
    template_folder=TEMPLATE_DIR,
    static_folder=STATIC_DIR
)
# Extend Jinja loader to also find recovery templates
app.jinja_loader = ChoiceLoader([
    FileSystemLoader(TEMPLATE_DIR),
    FileSystemLoader(RECOVERY_TEMPLATE),
])
CORS(app)
app.secret_key = "geo_secure_secret_key_2024"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# ─── RECOVERY STATIC FILE SERVING ────────────────────────────────────────────
from flask import Blueprint, send_from_directory as _sfd
recovery_bp = Blueprint('recovery_static', __name__)

RECOVERY_ADMIN_USERNAME = "recovery_admin@geosecure.com"
RECOVERY_ADMIN_PASSWORD = "recovery_control"

ADMIN_USERNAME = "secure_control@gmail.com"
ADMIN_PASSWORD = "secure_control"

WINDOW_SIZE = 168
FEATURES = [
    'temperature', 'precipitation', 'pressure', 'cloud_cover', 'magnitude',
    'hour_sin', 'hour_cos', 'month_sin', 'month_cos',
    'rain_roll24', 'rain_roll72', 'pres_trend'
]

RISK_LEVELS = {
    0: {"level": "SAFE",      "color": "#22c55e", "icon": "✅",
        "title": "Normal: Atmospheric Conditions Stable.",
        "steps": ["No immediate action required.", "Review emergency contacts.", "Check drainage around your area."]},
    1: {"level": "WATCH",     "color": "#eab308", "icon": "⚠️",
        "title": "WATCH: Moderate Weather Volatility.",
        "steps": ["Monitor app every 3 hours.", "Clear neighborhood drains.", "Prepare emergency kit.", "Charge power banks."]},
    2: {"level": "HIGH RISK", "color": "#e67e22", "icon": "🌊",
        "title": "ALERT: Multi-Hazard Conditions Detected.",
        "steps": ["Move valuables to upper floors.", "Secure outdoor objects.", "Avoid low-lying areas.", "Check first-aid kits."]},
    3: {"level": "CRITICAL",  "color": "#ef4444", "icon": "🚨",
        "title": "FLOOD ALERT: Heavy Rainfall Predicted!",
        "steps": ["EVACUATE low-lying zones immediately.", "Turn off gas and electricity.", "Call 1916 — Tamil Nadu Disaster Helpline.", "Move to emergency shelter.", "Do not cross flooded roads."]},
}

ROAD_BLOCK_IMAGES = [
    {"reason": "Flooded road detected",      "image": "flood.jpg"},
    {"reason": "Tree fallen on road",        "image": "tree.jpg"},
    {"reason": "Earthquake damaged road",    "image": "earthquake.jpg"},
    {"reason": "Heavy traffic congestion",   "image": "traffic.jpg"},
    {"reason": "Road under construction",    "image": "construction.jpg"},
]
road_blocks = []

# ─── MODEL LOADING ────────────────────────────────────────────────────────────
model, scaler, use_keras = None, None, False

try:
    scaler = joblib.load(SCALER_PATH)
    if os.path.exists(MODEL_PATH):
        from tensorflow.keras.models import load_model
        model = load_model(MODEL_PATH, compile=False)
        use_keras = True
        print("✅ Keras model loaded successfully!")
    else:
        sklearn_path = os.path.join(BASE_DIR, 'models', 'geosecure_sklearn.pkl')
        if os.path.exists(sklearn_path):
            model = joblib.load(sklearn_path)
            print("✅ Sklearn fallback model loaded!")
        else:
            print("❌ No model found — run train_model.py first!")
except Exception as e:
    print(f"❌ Model load error: {e}")

# ─── DATABASE INIT ────────────────────────────────────────────────────────────
def init_db():
    conn = sqlite3.connect(DATABASE)
    c = conn.cursor()
    c.execute('''
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        phone TEXT,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )''')
    c.execute('''
    CREATE TABLE IF NOT EXISTS sos_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        name TEXT NOT NULL,
        phone TEXT,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        medical_condition TEXT,
        vulnerability_tags TEXT,
        priority TEXT NOT NULL,
        priority_level TEXT,
        priority_color TEXT,
        status TEXT DEFAULT 'NEW',
        photo_path TEXT,
        is_offline BOOLEAN DEFAULT 0,
        hospital_name TEXT,
        hospital_lat REAL,
        hospital_lon REAL,
        reassigned_reason TEXT,
        risk_level_at_sos TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )''')
    # Migration for existing DBs
    for col in ["priority_level TEXT", "priority_color TEXT", "risk_level_at_sos TEXT",
                "dispatch_time TEXT", "route_coords TEXT", "route_duration REAL",
                "block_image TEXT", "reassigned_reason TEXT"]:
        try:
            c.execute(f"ALTER TABLE sos_requests ADD COLUMN {col}")
        except sqlite3.OperationalError:
            pass
    conn.commit()
    conn.close()

init_db()

# ─── MODULE 3 — RECOVERY DATABASE INIT ───────────────────────────────────────
def get_recovery_db():
    conn = sqlite3.connect(RECOVERY_DB)
    conn.row_factory = sqlite3.Row
    return conn

def init_recovery_db():
    conn = get_recovery_db()
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        phone TEXT,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS shelters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, address TEXT, latitude REAL, longitude REAL,
        total_capacity INTEGER DEFAULT 100, current_occupancy INTEGER DEFAULT 0,
        has_medical BOOLEAN DEFAULT 0, has_food BOOLEAN DEFAULT 1,
        has_water BOOLEAN DEFAULT 1, has_power BOOLEAN DEFAULT 0,
        status TEXT DEFAULT 'active', contact TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS victims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER, name TEXT NOT NULL, age INTEGER, gender TEXT, phone TEXT,
        medical_condition TEXT, vulnerability_tags TEXT,
        priority TEXT DEFAULT 'NORMAL', priority_color TEXT DEFAULT 'green',
        status TEXT DEFAULT 'missing', shelter_id INTEGER,
        latitude REAL, longitude REAL, notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (shelter_id) REFERENCES shelters(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS damage_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER, reporter_name TEXT, location TEXT,
        latitude REAL, longitude REAL, damage_type TEXT,
        severity TEXT DEFAULT 'medium', description TEXT, photo_path TEXT,
        status TEXT DEFAULT 'pending', verified_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS aid_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER, victim_id INTEGER, claimant_name TEXT,
        category TEXT, amount REAL, description TEXT,
        status TEXT DEFAULT 'pending', approved_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (victim_id) REFERENCES victims(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT, details TEXT, actor TEXT DEFAULT 'system',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )''')
    c.execute("SELECT COUNT(*) FROM shelters")
    if c.fetchone()[0] == 0:
        shelters = [
            ("Chennai Relief Camp Alpha","Anna Nagar, Chennai",13.0850,80.2101,200,87,1,1,1,1,"active","+91-9876543210"),
            ("Chennai South Emergency Hub","Tambaram, Chennai",12.9249,80.1000,250,110,1,1,1,1,"active","+91-9876543230"),
            ("Chennai North Relief Center","Ambattur, Chennai",13.1143,80.1548,180,65,1,1,1,0,"active","+91-9876543231"),
            ("Chennai Coastal Shelter","Besant Nagar, Chennai",13.0002,80.2707,150,90,1,1,1,1,"active","+91-9876543232"),
            ("Chennai West Safe Zone","Porur, Chennai",13.0359,80.1569,200,75,1,1,1,1,"active","+91-9876543233"),
            ("Chennai Central Aid Camp","Egmore, Chennai",13.0732,80.2609,300,140,1,1,1,1,"active","+91-9876543234"),
            ("Sholinganallur Relief Post","Sholinganallur, Chennai",12.9010,80.2279,120,50,1,1,1,0,"active","+91-9876543235"),
            ("Coimbatore Safe Zone","RS Puram, Coimbatore",11.0168,76.9558,150,112,1,1,1,0,"active","+91-9876543211"),
            ("Madurai Emergency Hub","Tallakulam, Madurai",9.9252,78.1198,300,45,1,1,1,1,"active","+91-9876543212"),
            ("Salem Rescue Center","Fairlands, Salem",11.6643,78.1460,120,98,0,1,1,0,"critical","+91-9876543213"),
            ("Tiruchirappalli Camp","Thillai Nagar, Trichy",10.7905,78.7047,250,180,1,1,1,1,"active","+91-9876543214"),
            ("Erode Relief Point","Perundurai Rd, Erode",11.3410,77.7172,80,67,0,1,1,0,"active","+91-9876543215"),
            ("Vellore Medical Camp","CMC Rd, Vellore",12.9165,79.1325,180,155,1,1,1,1,"critical","+91-9876543216"),
            ("Tirunelveli Hub","Palayamkottai, Tirunelveli",8.7139,77.7567,200,89,1,1,1,0,"active","+91-9876543217"),
            ("Kanchipuram Relief Base","Kanchipuram Town",12.8342,79.7036,160,40,1,1,1,1,"active","+91-9876543218"),
            ("Thanjavur Shelter Hub","Near Big Temple, Thanjavur",10.7870,79.1378,220,110,1,1,1,0,"active","+91-9876543219"),
            ("Pondicherry Coast Camp","Beach Road, Puducherry",11.9416,79.8083,130,75,1,1,1,1,"active","+91-9876543220"),
            ("Krishnagiri Emergency Post","NH-44, Krishnagiri",12.5185,78.2137,100,55,0,1,1,0,"active","+91-9876543221"),
        ]
        c.executemany("INSERT INTO shelters (name,address,latitude,longitude,total_capacity,current_occupancy,has_medical,has_food,has_water,has_power,status,contact) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", shelters)
    conn.commit()
    conn.close()

init_recovery_db()

def recovery_log(action, details, actor="system"):
    conn = get_recovery_db()
    c = conn.cursor()
    c.execute("INSERT INTO activity_log (action, details, actor) VALUES (?,?,?)", (action, details, actor))
    conn.commit()
    conn.close()

def row_to_dict(row):
    """Convert a sqlite3.Row to dict, appending 'Z' to bare datetime strings so JS
    parses them as UTC (avoids ±5:30 IST shift when toLocaleString is called)."""
    d = dict(row)
    for k, v in d.items():
        if isinstance(v, str) and len(v) >= 16 and 'T' not in v and v[4:5] == '-':
            d[k] = v.replace(' ', 'T') + 'Z'
    return d

# ─── PRE-DISASTER HELPERS ─────────────────────────────────────────────────────
def add_features(df):
    df = df.copy()
    if 'timestamp' in df.columns:
        df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
        df['hour']  = df['timestamp'].dt.hour
        df['month'] = df['timestamp'].dt.month
    else:
        df['hour']  = datetime.now().hour
        df['month'] = datetime.now().month
    df['hour_sin']    = np.sin(2 * np.pi * df['hour']  / 24)
    df['hour_cos']    = np.cos(2 * np.pi * df['hour']  / 24)
    df['month_sin']   = np.sin(2 * np.pi * df['month'] / 12)
    df['month_cos']   = np.cos(2 * np.pi * df['month'] / 12)
    df['rain_roll24'] = df['precipitation'].rolling(24, min_periods=1).sum()
    df['rain_roll72'] = df['precipitation'].rolling(72, min_periods=1).sum()
    df['pres_trend']  = df['pressure'].diff(6).fillna(0)
    if 'magnitude' not in df.columns:
        df['magnitude'] = 0.0
    return df

def predict_risk(window_df):
    if model is None:
        return rule_based_prediction(window_df)
    window_df = add_features(window_df)
    data = window_df[FEATURES].values.astype(np.float32)
    if len(data) < WINDOW_SIZE:
        pad = np.zeros((WINDOW_SIZE - len(data), data.shape[1]))
        data = np.vstack([pad, data])
    data   = data[-WINDOW_SIZE:]
    scaled = scaler.transform(data)
    if use_keras:
        proba      = model.predict(np.array([scaled]), verbose=0)[0]
        risk_class = int(np.argmax(proba))
        confidence = float(np.max(proba))
    else:
        X_flat     = scaled.flatten().reshape(1, -1)
        risk_class = int(model.predict(X_flat)[0])
        proba      = model.predict_proba(X_flat)[0]
        confidence = float(np.max(proba))
    return risk_class, confidence, proba.tolist()

def rule_based_prediction(window_df):
    recent   = window_df.tail(24)
    max_rain = recent['precipitation'].max() if 'precipitation' in recent else 0
    total_24 = recent['precipitation'].sum() if 'precipitation' in recent else 0
    if max_rain > 3.0 or total_24 > 12.1:  risk = 3
    elif max_rain > 1.7 or total_24 > 4.3: risk = 2
    elif max_rain > 0.5 or total_24 > 1.0: risk = 1
    else:                                   risk = 0
    proba = [0.0, 0.0, 0.0, 0.0]; proba[risk] = 1.0
    return risk, 1.0, proba

def get_seismic_data():
    try:
        url = ("https://earthquake.usgs.gov/fdsnws/event/1/query"
               "?format=geojson&latitude=13.08&longitude=80.27"
               "&maxradiuskm=500&minmagnitude=2.0")
        r = requests.get(url, timeout=5).json()
        if r['features']:
            latest = r['features'][0]['properties']
            return {"mag": latest['mag'], "place": latest['place']}
        return {"mag": 0.0, "place": "Seismic Zone Stable"}
    except:
        return {"mag": 0.0, "place": "Sensor Offline"}

def get_live_weather():
    url = ("https://api.open-meteo.com/v1/forecast"
           "?latitude=13.08&longitude=80.27"
           "&hourly=temperature_2m,precipitation,surface_pressure,cloud_cover,windspeed_10m"
           "&past_days=7&forecast_days=1&timezone=Asia/Kolkata")
    r = requests.get(url, timeout=10).json()
    h = r['hourly']
    df = pd.DataFrame({
        'time':          pd.to_datetime(h['time']),
        'temperature':   h['temperature_2m'],
        'precipitation': h['precipitation'],
        'pressure':      h['surface_pressure'],
        'cloud_cover':   h['cloud_cover'],
        'wind_speed':    h['windspeed_10m'],
        'magnitude':     0.0,
    })
    now_ist = datetime.now()
    limit = pd.Timestamp(year=now_ist.year, month=now_ist.month, day=now_ist.day, hour=now_ist.hour)
    return df[df['time'] <= limit].drop(columns=['time'])

# ─── DURING-DISASTER HELPERS ──────────────────────────────────────────────────
def calculate_distance(lat1, lon1, lat2, lon2):
    R = 6371
    lat1r, lat2r = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(lat1r)*math.cos(lat2r)*math.sin(dlon/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

# ───── HOSPITAL SEARCH WITH CACHING ──────────────────────────────────────────
hospital_cache = {}

def find_nearest_hospitals_overpass(lat, lng, radius_meters=10000, limit=5):
    # Cache key: lat/lng rounded to 2 decimals (~1.1km precision)
    cache_key = (round(lat, 2), round(lng, 2), radius_meters, limit)
    now = datetime.now()
    
    if cache_key in hospital_cache:
        entry, timestamp = hospital_cache[cache_key]
        if (now - timestamp).total_seconds() < 600: # 10 min cache
            return entry

    query = f"""
    [out:json][timeout:25];
    (node["amenity"="hospital"](around:{radius_meters},{lat},{lng});
     way["amenity"="hospital"](around:{radius_meters},{lat},{lng});
     relation["amenity"="hospital"](around:{radius_meters},{lat},{lng}););
    out center;
    """
    headers = {
        'User-Agent': 'GeoSecureBot/1.0 (Chennai Disaster Response Platform)',
        'Origin': 'http://localhost:5000',
        'Content-Type': 'text/plain'
    }
    
    try:
        r = requests.post("https://overpass-api.de/api/interpreter",
                          data=query, headers=headers, timeout=25)
        hospitals = []
        for el in r.json().get('elements', []):
            h_lat = el.get('lat') or el.get('center', {}).get('lat')
            h_lon = el.get('lon') or el.get('center', {}).get('lon')
            if not h_lat: continue
            tags = el.get('tags', {})
            hospitals.append({
                'id': el['id'],
                'name': tags.get('name', 'Unnamed Hospital'),
                'latitude': h_lat, 'longitude': h_lon,
                'distance': round(calculate_distance(lat, lng, h_lat, h_lon), 2)
            })
        
        hospitals.sort(key=lambda x: x['distance'])
        result = hospitals[:limit]
        if result:
            hospital_cache[cache_key] = (result, now)
        return result or [{'id':0,'name':'Emergency Services','latitude':lat+0.005,'longitude':lng+0.005,'distance':0.5}]
        
    except Exception as e:
        print(f"⚠️ Overpass API error: {e}")
        # Return a generic Emergency marker if API fails and no cache exists
        return [{'id':0,'name':'Emergency Services (Searching...)','latitude':lat+0.01,'longitude':lng+0.01,'distance':1.0}]

def find_nearest_hospital(lat, lng):
    h = find_nearest_hospitals_overpass(lat, lng, limit=1)[0]
    return {"name": h['name'], "lat": h['latitude'], "lng": h['longitude'], "distance": h['distance']}

def calculate_priority(medical_condition, vulnerability_tags):
    m = (medical_condition or "").lower()
    t = (vulnerability_tags or "").lower()

    # HIGH priority — immediate life threat
    high_vulnerability = ['elderly', 'pregnant', 'injured', 'trapped', 'disabled']
    high_medical = [
        'bleeding', 'fracture', 'broken', 'unconscious', 'unresponsive',
        'heart attack', 'chest pain', 'stroke', 'seizure', 'epilepsy',
        'difficulty breathing', 'trouble breathing', 'cant breathe', "can't breathe",
        'drowning', 'severe pain', 'critical', 'head injury', 'spinal',
        'paralysis', 'burn', 'crush'
    ]
    if any(kw in t for kw in high_vulnerability):
        return "HIGH", "red"
    if any(kw in m for kw in high_medical):
        return "HIGH", "red"

    # MEDIUM priority — needs assistance but stable
    medium_vulnerability = ['child', 'women', 'woman']
    medium_medical = ['pain', 'fever', 'diabetic', 'asthma', 'allergy', 'anxiety', 'panic', 'breathing', 'breath', 'inhale']
    if any(kw in t for kw in medium_vulnerability):
        return "MEDIUM", "orange"
    if any(kw in m for kw in medium_medical):
        return "MEDIUM", "orange"

    return "NORMAL", "green"

def get_current_risk_level():
    """Get current prediction risk level to attach to SOS requests"""
    try:
        window = get_live_weather()
        seismic = get_seismic_data()
        window['magnitude'] = seismic['mag']
        risk_class, _, _ = predict_risk(window)
        return RISK_LEVELS[risk_class]['level']
    except:
        return "UNKNOWN"

# ═══════════════════════════════════════════════════════════════════════════════
# ROUTES
# ═══════════════════════════════════════════════════════════════════════════════

# ─── HUB — Landing page connecting both phases ────────────────────────────────
@app.route('/')
def hub():
    """Central navigation hub connecting Pre-Disaster and During-Disaster phases"""
    hub_path = os.path.join(BASE_DIR, 'frontend', 'hub.html')
    if os.path.exists(hub_path):
        with open(hub_path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()
    # Fallback inline hub
    return """
    <!DOCTYPE html>
    <html>
    <head>
        <title>GeoSecure Chennai</title>
        <style>
            * { margin:0; padding:0; box-sizing:border-box; }
            body { background:#0a0f1e; color:white; font-family:'Segoe UI',sans-serif;
                   display:flex; flex-direction:column; align-items:center;
                   justify-content:center; min-height:100vh; }
            h1 { font-size:2.5rem; margin-bottom:0.5rem; color:#38bdf8; }
            p  { color:#94a3b8; margin-bottom:3rem; font-size:1.1rem; }
            .cards { display:flex; gap:2rem; flex-wrap:wrap; justify-content:center; }
            .card { background:#1e2a3a; border:1px solid #334155; border-radius:16px;
                    padding:2.5rem 2rem; width:280px; text-align:center;
                    text-decoration:none; color:white; transition:transform 0.2s, border-color 0.2s; }
            .card:hover { transform:translateY(-6px); border-color:#38bdf8; }
            .card .icon { font-size:3rem; margin-bottom:1rem; }
            .card h2 { font-size:1.3rem; margin-bottom:0.5rem; }
            .card p  { font-size:0.9rem; color:#94a3b8; margin-bottom:0; }
            .badge { display:inline-block; padding:3px 10px; border-radius:20px;
                     font-size:0.75rem; margin-top:1rem; }
            .pre  { background:#166534; color:#86efac; }
            .during { background:#7c2d12; color:#fca5a5; }
        </style>
    </head>
    <body>
        <h1>🛡️ GeoSecure Chennai</h1>
        <p>72-Hour AI Disaster Prediction & Response Platform</p>
        <div class="cards">
            <a href="/pre-disaster" class="card">
                <div class="icon">🔮</div>
                <h2>Pre-Disaster</h2>
                <p>72-hour flood risk prediction with live weather monitoring and AI forecast</p>
                <span class="badge pre">Prediction Engine</span>
            </a>
            <a href="/victim" class="card">
                <div class="icon">🚨</div>
                <h2>During-Disaster</h2>
                <p>Emergency SOS submission, rescue coordination, and real-time routing</p>
                <span class="badge during">Response System</span>
            </a>
            <a href="/admin/dashboard" class="card">
                <div class="icon">🗺️</div>
                <h2>Rescue Control</h2>
                <p>Admin dashboard for managing SOS requests, road blocks, and hospital routing</p>
                <span class="badge during">Admin Only</span>
            </a>
        </div>
    </body>
    </html>
    """

# ─── PRE-DISASTER ROUTES ──────────────────────────────────────────────────────
@app.route('/pre-disaster')
def pre_disaster_dashboard():
    """Serve the existing pre-disaster dashboard HTML"""
    dashboard_path = os.path.join(BASE_DIR, 'frontend', 'dashboard.html')
    if os.path.exists(dashboard_path):
        with open(dashboard_path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()
    return "Pre-disaster dashboard not found. Ensure frontend/dashboard.html exists.", 404

@app.route('/api/predict')
def predict():
    mode = request.args.get('mode', 'live')
    try:
        seismic = get_seismic_data()
        if mode == 'simulation':
            target_date = pd.to_datetime(request.args.get('date'), utc=True)
            df = pd.read_csv(DATA_PATH)
            df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
            window = df[df['timestamp'] <= target_date].tail(WINDOW_SIZE).copy()
            if len(window) < 24:
                return jsonify({"error": f"No data for date. Use dates between 2015-2025."}), 400
            window['magnitude'] = seismic['mag']
        else:
            window = get_live_weather()
            window['magnitude'] = seismic['mag']

        risk_class, confidence, proba = predict_risk(window)
        meta    = RISK_LEVELS[risk_class]
        recent  = window.tail(1).iloc[0]
        
        # Wind simulation fallback if column missing (common in historical CSV)
        wind_val = recent.get('wind_speed')
        if wind_val is None or pd.isna(wind_val):
            # Base wind 12km/h + dynamic increase based on rain + variance
            rain_impact = float(recent.get('precipitation', 0)) * 4.5
            wind_val = 12.0 + rain_impact + random.uniform(-3, 3)
            
        current = {
            "rain":     round(float(recent.get('precipitation', 0)), 2),
            "wind":     round(float(wind_val), 1),
            "pressure": round(float(recent.get('pressure', 1013)), 1),
            "temp":     round(float(recent.get('temperature', 28)), 1),
        }
        trend_data = window.tail(24)[['precipitation']].values.flatten().tolist()

        return jsonify({
            "risk_class":  risk_class,
            "risk_level":  meta["level"],
            "color":       meta["color"],
            "icon":        meta["icon"],
            "title":       meta["title"],
            "steps":       meta["steps"],
            "confidence":  round(confidence * 100, 1),
            "probabilities": {RISK_LEVELS[i]["level"]: round(p*100, 1) for i, p in enumerate(proba)},
            "current":     current,
            "seismic":     seismic,
            "trend":       trend_data,
            "timestamp":   datetime.now().isoformat(),
            "mode":        mode,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/history')
def history():
    try:
        df = pd.read_csv(DATA_PATH)
        df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
        # Take the past year of data only
        one_year_ago = pd.Timestamp.now(tz='UTC') - pd.Timedelta(days=365)
        df = df[df['timestamp'] >= one_year_ago]
        # Group by date and compute daily max precip
        df['date'] = df['timestamp'].dt.strftime('%Y-%m-%d')
        daily = df.groupby('date').agg(max_rain=('precipitation','max')).reset_index()
        def classify(r):
            if r >= 50: return 3   # CRITICAL
            if r >= 15: return 2   # HIGH RISK
            if r  >= 2: return 1   # WATCH
            return 0               # SAFE
        daily['risk'] = daily['max_rain'].apply(classify)
        return jsonify(daily[['date','risk']].to_dict(orient='records'))
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/stats')
def stats():
    try:
        df = pd.read_csv(DATA_PATH)
        return jsonify({
            "total_records": len(df),
            "date_range": {
                "start": str(df['timestamp'].min()),
                "end":   str(df['timestamp'].max())
            },
            "max_rain": float(df['precipitation'].max()),
            "avg_rain": round(float(df['precipitation'].mean()), 4),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ─── DURING-DISASTER AUTH ROUTES ──────────────────────────────────────────────
@app.route('/victim')
def victim_home():
    if not session.get('user_id') and not session.get('recovery_user_id'):
        return redirect('/user/login')
    return render_template('victim/index.html')

@app.route('/shelters')
def shelters_page():
    """Public shelter browser — accessible to any logged-in user, no separate login needed"""
    if not session.get('user_id') and not session.get('recovery_user_id'):
        return redirect('/user/login')
    frontend_path = os.path.join(BASE_DIR, 'frontend', 'shelters.html')
    with open(frontend_path, 'r', encoding='utf-8') as f:
        return f.read()

@app.route('/user/login', methods=['GET','POST'])
def user_login():
    try:
        if request.method == 'POST':
            email    = request.form.get('email','').strip()
            password = request.form.get('password','').strip()
            print(f"🔐 Login attempt: {email}")

            # Single admin login — both credential sets land on unified admin dashboard
            if (email == ADMIN_USERNAME and password == ADMIN_PASSWORD) or \
               (email == RECOVERY_ADMIN_USERNAME and password == RECOVERY_ADMIN_PASSWORD):
                session['admin'] = True
                session['recovery_admin'] = True
                print("✅ Admin login success")
                return redirect('/admin/dashboard')

            # Check Module 2 user DB (disaster_management.db)
            conn = sqlite3.connect(DATABASE)
            c    = conn.cursor()
            c.execute("SELECT id FROM users WHERE email=? AND password=?", (email, password))
            user = c.fetchone()
            conn.close()

            if user:
                session['user_id'] = user[0]
                session['recovery_user_id'] = user[0]  # also grants shelter/recovery API access
                print(f"✅ User login success: id={user[0]}")
                return redirect('/victim')

            # Check Module 3 recovery DB (recovery.db)
            conn3 = get_recovery_db()
            c3    = conn3.cursor()
            c3.execute("SELECT id, name FROM users WHERE email=? AND password=?", (email, password))
            ruser = c3.fetchone()
            conn3.close()

            if ruser:
                session['recovery_user_id']   = ruser['id']
                session['recovery_user_name'] = ruser['name']
                session['user_id'] = ruser['id']  # allows SOS page access
                print(f"✅ Recovery user login: id={ruser['id']}")
                return redirect('/victim')

            print("❌ Invalid credentials")
            return render_template('auth/login.html', error="Invalid email or password. Please try again.")

        return render_template('auth/login.html', error=None)

    except Exception as e:
        import traceback
        print(f"❌ LOGIN ERROR: {e}")
        traceback.print_exc()
        return f"<h2>Login Error</h2><pre>{traceback.format_exc()}</pre><a href='/user/login'>Back</a>", 500

@app.route('/user/register', methods=['GET','POST'])
def user_register():
    if request.method == 'POST':
        data = request.form
        conn = sqlite3.connect(DATABASE)
        c    = conn.cursor()
        try:
            c.execute("INSERT INTO users (name,email,phone,password) VALUES (?,?,?,?)",
                      (data['name'], data['email'], data['phone'], data['password']))
            conn.commit()
            uid = c.lastrowid
            conn.close()
            session['user_id'] = uid
            session['recovery_user_id'] = uid
            return redirect('/victim')
        except sqlite3.IntegrityError:
            conn.close()
            return render_template('auth/register.html', error="Email already exists. Please try a different one.")
    return render_template('auth/register.html', error=None)

@app.route('/user/logout')
def user_logout():
    session.clear()
    return redirect('/user/login')

# ─── DURING-DISASTER SOS ROUTES ───────────────────────────────────────────────
@app.route('/api/victim/sos', methods=['POST'])
def create_sos():
    if not session.get('user_id'):
        return jsonify({"success": False, "error": "Not logged in"}), 401
    try:
        user_id = session['user_id']
        conn = sqlite3.connect(DATABASE)
        c    = conn.cursor()
        c.execute("SELECT name, phone FROM users WHERE id=?", (user_id,))
        user = c.fetchone()
        if not user:
            conn.close()
            return jsonify({"success": False, "error": "User not found"}), 404

        name, phone = user[0], user[1] or "N/A"
        data = request.form

        try:
            user_lat = float(data.get('latitude'))
            user_lng = float(data.get('longitude'))
        except (TypeError, ValueError):
            return jsonify({"success": False, "error": "Invalid location"}), 400

        hospital           = find_nearest_hospital(user_lat, user_lng)
        medical            = data.get('medical_condition', '')
        vulnerability      = data.get('vulnerability_tags', '')
        priority_level, priority_color = calculate_priority(medical, vulnerability)

        # ★ KEY INTEGRATION: attach current pre-disaster risk level to each SOS
        current_risk = get_current_risk_level()

        # Elevate SOS priority if prediction says CRITICAL
        if current_risk == 'CRITICAL' and priority_level == 'NORMAL':
            priority_level  = 'HIGH'
            priority_color  = 'red'

        photo = request.files.get('photo')
        photo_filename = None
        if photo and photo.filename:
            photo_filename = f"{datetime.now().strftime('%Y%m%d%H%M%S')}_{photo.filename}"
            photo.save(os.path.join(UPLOAD_FOLDER, photo_filename))

        c.execute("""
            INSERT INTO sos_requests
            (user_id, name, phone, latitude, longitude, medical_condition,
             vulnerability_tags, priority, priority_level, priority_color,
             photo_path, is_offline, hospital_name, hospital_lat, hospital_lon,
             status, risk_level_at_sos)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (user_id, name, phone, user_lat, user_lng, medical, vulnerability,
              priority_level, priority_level, priority_color, photo_filename,
              False, hospital['name'], hospital['lat'], hospital['lng'],
              'NEW', current_risk))

        sos_id = c.lastrowid
        conn.commit()
        conn.close()

        return jsonify({
            "success": True, "sos_id": sos_id,
            "name": name, "phone": phone,
            "priority": priority_level, "priority_color": priority_color,
            "current_risk_level": current_risk,
            "user_lat": user_lat, "user_lng": user_lng,
            "hospital": hospital
        })
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/api/victim/sos/<int:sos_id>/cancel', methods=['POST'])
def cancel_sos(sos_id):
    if not session.get('user_id'):
        return jsonify({"error": "Not logged in"}), 401
    try:
        conn = sqlite3.connect(DATABASE)
        c    = conn.cursor()
        # Only allow cancelling own SOS that hasn't been rescued yet
        c.execute("""UPDATE sos_requests SET status='Cancelled', updated_at=?
                     WHERE id=? AND user_id=? AND status NOT IN ('Rescued','Cancelled')""",
                  (datetime.now(), sos_id, session['user_id']))
        conn.commit(); conn.close()
        print(f"🚫 SOS #{sos_id} cancelled by user")
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/victim/my-sos')
def get_my_sos():
    if not session.get('user_id'):
        return jsonify({"error": "Not logged in"}), 401
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT * FROM sos_requests WHERE user_id=? ORDER BY timestamp DESC LIMIT 1",
              (session['user_id'],))
    sos = c.fetchone()
    conn.close()
    if not sos:
        return jsonify({"found": False})
    return jsonify({"found": True, "sos": dict(sos)})

@app.route('/api/user/location', methods=['POST'])
def update_user_location():
    if not session.get('user_id'):
        return jsonify({"error": "Not logged in"}), 401
    try:
        data = request.json
        conn = sqlite3.connect(DATABASE)
        c    = conn.cursor()
        c.execute("""SELECT id FROM sos_requests
                     WHERE user_id=? AND status NOT IN ('Rescued','Cancelled')
                     ORDER BY timestamp DESC LIMIT 1""", (session['user_id'],))
        row = c.fetchone()
        if row:
            c.execute("UPDATE sos_requests SET latitude=?, longitude=?, updated_at=? WHERE id=?",
                      (float(data['latitude']), float(data['longitude']), datetime.now(), row[0]))
            conn.commit()
        conn.close()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ─── SHARED AMBULANCE SYNC API ───────────────────────────────────────────────

@app.route('/api/sos/<int:sos_id>/route', methods=['POST'])
def save_route(sos_id):
    """Admin calls this when dispatching — saves route coords + dispatch timestamp"""
    if not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    try:
        data = request.json
        import json as _json
        conn = sqlite3.connect(DATABASE)
        c    = conn.cursor()
        c.execute("""UPDATE sos_requests
                     SET route_coords=?, route_duration=?, dispatch_time=?, updated_at=?
                     WHERE id=?""",
                  (_json.dumps(data['coords']),
                   data['duration'],
                   datetime.now().isoformat(),
                   datetime.now(), sos_id))
        conn.commit(); conn.close()
        print(f"✅ Route saved for SOS #{sos_id}: {len(data['coords'])} points, {data['duration']}s")
        return jsonify({"success": True})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route('/api/sos/<int:sos_id>/ambulance-position')
def ambulance_position(sos_id):
    """Both admin and victim poll this — returns ambulance lat/lng based on elapsed time"""
    try:
        import json as _json
        conn = sqlite3.connect(DATABASE)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()
        c.execute("SELECT * FROM sos_requests WHERE id=?", (sos_id,))
        sos = c.fetchone(); conn.close()
        if not sos:
            return jsonify({"error": "SOS not found"}), 404

        sos = dict(sos)

        # Not dispatched yet or no route saved
        if sos['status'] not in ('Assigned',) or not sos.get('route_coords') or not sos.get('dispatch_time'):
            return jsonify({
                "ready": False,
                "status": sos['status'],
                "hospital_lat": sos.get('hospital_lat'),
                "hospital_lon": sos.get('hospital_lon'),
                "hospital_name": sos.get('hospital_name'),
            })

        coords       = _json.loads(sos['route_coords'])  # [[lat,lng], ...]
        total_dur    = float(sos['route_duration'])       # seconds
        dispatch_dt  = datetime.fromisoformat(sos['dispatch_time'])
        elapsed      = (datetime.now() - dispatch_dt).total_seconds()

        # Clamp progress 0→1
        progress = min(elapsed / total_dur, 1.0) if total_dur > 0 else 1.0
        idx      = min(int(progress * (len(coords) - 1)), len(coords) - 1)

        amb_lat = coords[idx][0]
        amb_lng = coords[idx][1]
        eta_sec = max(0, int(total_dur - elapsed))
        
        print(f"🚑 API POLL: SOS {sos_id} | Progress: {progress:.2%} | ETA: {eta_sec}s | Elapsed: {elapsed:.1f}s / {total_dur}s")

        return jsonify({
            "ready":        True,
            "status":       sos['status'],
            "progress":     round(progress, 4),
            "amb_lat":      amb_lat,
            "amb_lng":      amb_lng,
            "eta_seconds":  eta_sec,
            "route_coords": coords,
            "hospital_lat": sos.get('hospital_lat'),
            "hospital_lon": sos.get('hospital_lon'),
            "hospital_name": sos.get('hospital_name'),
            "total_points": len(coords),
            "current_index": idx,
        })
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────
@app.route('/admin/dashboard')
def admin_dashboard():
    if not session.get('admin') and not session.get('recovery_admin'):
        return redirect('/user/login')
    # Unified admin hub — two cards: Rescue Control Room + Recovery Command
    admin_hub_path = os.path.join(BASE_DIR, 'frontend', 'admin_hub.html')
    if os.path.exists(admin_hub_path):
        with open(admin_hub_path, 'r', encoding='utf-8') as f:
            return f.read()
    return redirect('/admin/rescue')

@app.route('/admin/rescue')
def admin_rescue():
    """The original rescue control room"""
    if not session.get('admin') and not session.get('recovery_admin'):
        return redirect('/user/login')
    return render_template('admin/dashboard.html')

@app.route('/admin/recovery')
def admin_recovery():
    """Recovery command dashboard"""
    if not session.get('admin') and not session.get('recovery_admin'):
        return redirect('/user/login')
    return render_template('recovery/dashboard.html')

@app.route('/api/admin/sos', methods=['GET'])
def list_sos():
    if not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("""SELECT * FROM sos_requests
                 ORDER BY CASE
                     WHEN priority='HIGH'   THEN 1
                     WHEN priority='MEDIUM' THEN 2
                     ELSE 3 END ASC, timestamp DESC""")
    rows = c.fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

@app.route('/api/admin/sos/<int:sos_id>/location')
def get_sos_location(sos_id):
    if not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT latitude, longitude, updated_at FROM sos_requests WHERE id=?", (sos_id,))
    sos = c.fetchone()
    conn.close()
    if not sos: return jsonify({"error": "Not found"}), 404
    return jsonify(dict(sos))

@app.route('/api/admin/sos/<int:sos_id>/hospital', methods=['PUT'])
def update_sos_hospital(sos_id):
    if not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    data = request.json
    conn = sqlite3.connect(DATABASE)
    c    = conn.cursor()
    c.execute("""UPDATE sos_requests
                 SET hospital_name=?, hospital_lat=?, hospital_lon=?,
                     reassigned_reason=?, block_image=?, updated_at=?
                 WHERE id=?""",
              (data.get('hospital_name'), data.get('hospital_lat'), data.get('hospital_lon'),
               data.get('reassigned_reason','Reassigned'), data.get('block_image'),
               datetime.now(), sos_id))
    conn.commit(); conn.close()
    return jsonify({"success": True})

@app.route('/api/admin/sos/<int:sos_id>/status', methods=['PUT'])
def update_status(sos_id):
    if not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    conn = sqlite3.connect(DATABASE)
    c    = conn.cursor()
    c.execute("UPDATE sos_requests SET status=?, updated_at=? WHERE id=?",
              (request.json.get('status'), datetime.now(), sos_id))
    conn.commit(); conn.close()
    return jsonify({"success": True})

@app.route('/api/admin/sos/<int:sos_id>', methods=['DELETE'])
def delete_sos(sos_id):
    if not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    conn = sqlite3.connect(DATABASE)
    c    = conn.cursor()
    c.execute("DELETE FROM sos_requests WHERE id=?", (sos_id,))
    conn.commit(); conn.close()
    return jsonify({"success": True})

@app.route('/api/hospitals')
def get_hospitals():
    try:
        hospitals = find_nearest_hospitals_overpass(
            float(request.args.get('lat')), float(request.args.get('lng')),
            int(request.args.get('radius', 10000)), int(request.args.get('limit', 5))
        )
        return jsonify(hospitals)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ─── ROAD BLOCK ROUTES ────────────────────────────────────────────────────────
@app.route('/api/admin/roadblock', methods=['POST'])
def add_roadblock():
    if not session.get('admin'): return jsonify({"error": "Unauthorized"}), 401
    data = request.json
    # Pick a random disaster reason
    rb = random.choice(ROAD_BLOCK_IMAGES)
    block = {
        "lat": data['lat'], 
        "lng": data['lng'], 
        "reason": rb['reason'], 
        "image": rb['image']
    }
    road_blocks.append(block)
    return jsonify({**block, "success": True})

@app.route('/api/admin/roadblocks')
def get_all_roadblocks():
    if not session.get('admin') and not session.get('user_id') and not session.get('recovery_user_id'): return jsonify({"error": "Unauthorized"}), 401
    return jsonify({"road_blocks": road_blocks})

@app.route('/api/simulate-roadblock')
def simulate_roadblock():
    if not session.get('admin'): return jsonify({"error": "Unauthorized"}), 401
    conn = sqlite3.connect(DATABASE)
    c    = conn.cursor()
    c.execute("SELECT latitude, longitude FROM sos_requests ORDER BY id DESC LIMIT 1")
    last = c.fetchone()
    conn.close()
    base_lat, base_lng = last if last else (13.08, 80.27)
    lat = base_lat + random.uniform(-0.02, 0.02)
    lng = base_lng + random.uniform(-0.02, 0.02)
    rb  = random.choice(ROAD_BLOCK_IMAGES)
    road_block_data = {"lat": lat, "lng": lng, "reason": rb['reason'], "image": rb['image']}
    road_blocks.append(road_block_data)
    return jsonify(road_block_data)

@app.route('/api/admin/roadblock/clear', methods=['POST'])
def clear_roadblocks():
    if not session.get('admin'): return jsonify({"error": "Unauthorized"}), 401
    road_blocks.clear()
    return jsonify({"success": True})

@app.route('/api/admin/route', methods=['POST'])
def get_route_data():
    if not session.get('admin'): return jsonify({"error": "Unauthorized"}), 401
    return jsonify({"road_blocks": road_blocks})

@app.route('/uploads/<filename>')
def uploaded_file(filename):
    return send_from_directory(UPLOAD_FOLDER, filename)

# ═══════════════════════════════════════════════════════════════════════════════
# MODULE 3 — POST-DISASTER RECOVERY ROUTES
# ═══════════════════════════════════════════════════════════════════════════════

# ─── Serve recovery static assets ─────────────────────────────────────────────
@app.route('/recovery/static/<path:filename>')
def recovery_static(filename):
    return send_from_directory(RECOVERY_STATIC, filename)

@app.route('/recovery/uploads/<filename>')
def recovery_upload(filename):
    return send_from_directory(RECOVERY_UPLOADS, filename)

# ─── Recovery Auth ────────────────────────────────────────────────────────────
@app.route('/recovery/logout')
def recovery_logout():
    session.clear()
    return redirect('/user/login')

# ─── Recovery Pages ───────────────────────────────────────────────────────────
@app.route('/recovery/dashboard')
def recovery_dashboard():
    if not session.get('admin') and not session.get('recovery_admin'):
        return redirect('/user/login')
    return render_template('recovery/dashboard.html')

# ─── Recovery API — Stats ─────────────────────────────────────────────────────
@app.route('/api/recovery/stats')
def recovery_stats():
    if not session.get('recovery_admin') and not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("SELECT COUNT(*) FROM victims");          total     = c.fetchone()[0]
    c.execute("SELECT COUNT(*) FROM victims WHERE status='rescued'");  rescued   = c.fetchone()[0]
    c.execute("SELECT COUNT(*) FROM victims WHERE status='missing'");  missing   = c.fetchone()[0]
    c.execute("SELECT COUNT(*) FROM victims WHERE status='sheltered'"); sheltered = c.fetchone()[0]
    c.execute("SELECT COUNT(*) FROM shelters WHERE status!='closed'"); tshelters = c.fetchone()[0]
    c.execute("SELECT COALESCE(SUM(total_capacity),0) FROM shelters"); tbeds     = c.fetchone()[0]
    c.execute("SELECT COALESCE(SUM(current_occupancy),0) FROM shelters"); tocc   = c.fetchone()[0]
    c.execute("SELECT COUNT(*) FROM victims WHERE priority='HIGH'");   critical  = c.fetchone()[0]
    c.execute("SELECT COUNT(*) FROM damage_reports WHERE status='pending'"); preports = c.fetchone()[0]
    c.execute("SELECT COUNT(*) FROM aid_claims WHERE status='pending'");     pclaims  = c.fetchone()[0]
    conn.close()
    # Cross-module: also pull rescued SOS count from Module 1/2 database
    try:
        conn2 = sqlite3.connect(DATABASE)
        c2    = conn2.cursor()
        c2.execute("SELECT COUNT(*) FROM sos_requests WHERE status='Rescued'")
        sos_rescued = c2.fetchone()[0]
        conn2.close()
    except:
        sos_rescued = 0
    return jsonify({
        "total_victims": total, "rescued": rescued, "missing": missing, "sheltered": sheltered,
        "total_shelters": tshelters, "total_beds": tbeds, "occupied_beds": tocc,
        "available_beds": tbeds - tocc, "critical": critical,
        "pending_reports": preports, "pending_claims": pclaims,
        "sos_rescued": sos_rescued,
        "recovery_progress": round((rescued / total * 100) if total > 0 else 0, 1)
    })

# ─── Recovery API — Shelters ──────────────────────────────────────────────────
@app.route('/api/recovery/shelters', methods=['GET'])
def recovery_get_shelters():
    # Any logged-in user (victim or recovery) can view shelters
    if not session.get('admin') and not session.get('recovery_admin') \
       and not session.get('user_id') and not session.get('recovery_user_id'):
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("SELECT * FROM shelters ORDER BY status DESC, name")
    rows = c.fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

@app.route('/api/recovery/shelters', methods=['POST'])
def recovery_create_shelter():
    if not session.get('recovery_admin') and not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    data = request.json
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("INSERT INTO shelters (name,address,latitude,longitude,total_capacity,current_occupancy,has_medical,has_food,has_water,has_power,status,contact) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (data['name'], data.get('address'), data.get('latitude'), data.get('longitude'),
         data.get('total_capacity', 100), data.get('current_occupancy', 0),
         data.get('has_medical', 0), data.get('has_food', 1),
         data.get('has_water', 1), data.get('has_power', 0),
         data.get('status', 'active'), data.get('contact')))
    sid = c.lastrowid
    conn.commit()
    conn.close()
    recovery_log("SHELTER_CREATED", f"Shelter #{sid}: {data['name']}")
    return jsonify({"success": True, "id": sid})

@app.route('/api/recovery/shelters/<int:sid>', methods=['GET'])
def recovery_get_shelter(sid):
    if not session.get('recovery_admin') and not session.get('admin') and not session.get('recovery_user_id'):
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("SELECT * FROM shelters WHERE id=?", (sid,))
    s = c.fetchone()
    c.execute("SELECT * FROM victims WHERE shelter_id=?", (sid,))
    victims = c.fetchall()
    conn.close()
    if not s:
        return jsonify({"error": "Not found"}), 404
    data = dict(s)
    data['victims'] = [dict(v) for v in victims]
    return jsonify(data)

@app.route('/api/recovery/shelters/<int:sid>/update', methods=['PUT'])
def recovery_update_shelter(sid):
    if not session.get('recovery_admin') and not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    data = request.json
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("UPDATE shelters SET current_occupancy=?,status=? WHERE id=?",
              (data.get('current_occupancy'), data.get('status'), sid))
    conn.commit()
    conn.close()
    recovery_log("SHELTER_UPDATE", f"Shelter #{sid} updated")
    return jsonify({"success": True})

# ─── Recovery API — Victims ───────────────────────────────────────────────────
@app.route('/api/recovery/victims', methods=['GET'])
def recovery_get_victims():
    if not session.get('recovery_admin') and not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_recovery_db()
    c    = conn.cursor()
    q      = request.args.get('q', '')
    status = request.args.get('status', '')
    order  = "ORDER BY CASE v.priority WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, v.created_at DESC"
    if q:
        c.execute(f"SELECT v.*,s.name as shelter_name FROM victims v LEFT JOIN shelters s ON v.shelter_id=s.id WHERE v.name LIKE ? OR v.medical_condition LIKE ? {order}", (f'%{q}%', f'%{q}%'))
    elif status:
        c.execute(f"SELECT v.*,s.name as shelter_name FROM victims v LEFT JOIN shelters s ON v.shelter_id=s.id WHERE v.status=? {order}", (status,))
    else:
        c.execute(f"SELECT v.*,s.name as shelter_name FROM victims v LEFT JOIN shelters s ON v.shelter_id=s.id {order}")
    rows = c.fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

@app.route('/api/recovery/victims', methods=['POST'])
def recovery_create_victim():
    if not session.get('recovery_admin') and not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    data = request.json
    if not data.get('name'):
        return jsonify({"error": "Name required"}), 400
    priority = data.get('priority', 'NORMAL')
    pcolor   = {'HIGH': 'red', 'MEDIUM': 'orange', 'NORMAL': 'green'}.get(priority, 'green')
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("INSERT INTO victims (name,age,gender,phone,medical_condition,vulnerability_tags,priority,priority_color,status,latitude,longitude,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (data['name'], data.get('age'), data.get('gender'), data.get('phone'),
         data.get('medical_condition'), data.get('vulnerability_tags'),
         priority, pcolor, data.get('status', 'missing'),
         data.get('latitude'), data.get('longitude'), data.get('notes')))
    vid = c.lastrowid
    conn.commit()
    conn.close()
    recovery_log("VICTIM_ADDED", f"Victim {data['name']} added (ID #{vid})")
    return jsonify({"success": True, "id": vid})

@app.route('/api/recovery/victims/<int:vid>', methods=['GET'])
def recovery_get_victim(vid):
    if not session.get('recovery_admin') and not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("SELECT v.*,s.name as shelter_name FROM victims v LEFT JOIN shelters s ON v.shelter_id=s.id WHERE v.id=?", (vid,))
    v = c.fetchone()
    conn.close()
    if not v:
        return jsonify({"error": "Not found"}), 404
    return jsonify(dict(v))

@app.route('/api/recovery/victims/<int:vid>/status', methods=['PUT'])
def recovery_update_victim_status(vid):
    if not session.get('recovery_admin') and not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    data = request.json
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("UPDATE victims SET status=?,updated_at=? WHERE id=?", (data['status'], datetime.now(), vid))
    conn.commit()
    conn.close()
    recovery_log("VICTIM_STATUS", f"Victim #{vid} -> {data['status']}")
    return jsonify({"success": True})

@app.route('/api/recovery/victims/<int:vid>/assign', methods=['PUT'])
def recovery_assign_victim(vid):
    if not session.get('recovery_admin') and not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    data = request.json
    sid  = data.get('shelter_id')
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("SELECT shelter_id FROM victims WHERE id=?", (vid,))
    old = c.fetchone()
    if old and old['shelter_id']:
        c.execute("UPDATE shelters SET current_occupancy=MAX(0,current_occupancy-1) WHERE id=?", (old['shelter_id'],))
    c.execute("UPDATE victims SET shelter_id=?,status='sheltered',updated_at=? WHERE id=?", (sid, datetime.now(), vid))
    if sid:
        c.execute("UPDATE shelters SET current_occupancy=current_occupancy+1 WHERE id=?", (sid,))
    conn.commit()
    conn.close()
    recovery_log("VICTIM_ASSIGNED", f"Victim #{vid} -> shelter #{sid}")
    return jsonify({"success": True})

# ─── Recovery API — Damage Reports ───────────────────────────────────────────
@app.route('/api/recovery/damage-reports', methods=['GET'])
def recovery_get_damage_reports():
    if not session.get('recovery_admin') and not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("SELECT * FROM damage_reports ORDER BY created_at DESC")
    rows = c.fetchall()
    conn.close()
    return jsonify([row_to_dict(r) for r in rows])

@app.route('/api/recovery/damage-reports', methods=['POST'])
def recovery_create_damage_report():
    data       = request.form
    photo      = request.files.get('photo')
    photo_path = None
    if photo and photo.filename:
        photo_path = f"{datetime.now().strftime('%Y%m%d%H%M%S')}_{photo.filename.replace(' ', '_')}"
        photo.save(os.path.join(RECOVERY_UPLOADS, photo_path))
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("INSERT INTO damage_reports (user_id,reporter_name,location,latitude,longitude,damage_type,severity,description,photo_path) VALUES (?,?,?,?,?,?,?,?,?)",
        (session.get('recovery_user_id'), data.get('reporter_name'), data.get('location'),
         data.get('latitude'), data.get('longitude'), data.get('damage_type'),
         data.get('severity', 'medium'), data.get('description'), photo_path))
    rid = c.lastrowid
    conn.commit()
    conn.close()
    recovery_log("DAMAGE_REPORT", f"Report #{rid} from {data.get('location')}")
    return jsonify({"success": True, "id": rid})

@app.route('/api/recovery/damage-reports/<int:rid>/action', methods=['PUT'])
def recovery_action_damage_report(rid):
    if not session.get('recovery_admin') and not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    data = request.json
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("UPDATE damage_reports SET status=?,verified_by=? WHERE id=?",
              (data['status'], data.get('actor', 'admin'), rid))
    conn.commit()
    conn.close()
    recovery_log("REPORT_ACTION", f"Report #{rid} {data['status']}")
    return jsonify({"success": True})

@app.route('/api/recovery/damage-reports/<int:rid>', methods=['DELETE'])
def recovery_delete_damage_report(rid):
    if not session.get('recovery_admin') and not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("DELETE FROM damage_reports WHERE id=?", (rid,))
    conn.commit()
    conn.close()
    recovery_log("REPORT_DELETE", f"Report #{rid} deleted by admin")
    return jsonify({"success": True})

# ─── Recovery API — Aid Claims ────────────────────────────────────────────────
@app.route('/api/recovery/aid-claims', methods=['GET'])
def recovery_get_aid_claims():
    if not session.get('recovery_admin') and not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("SELECT a.*,v.name as victim_name FROM aid_claims a LEFT JOIN victims v ON a.victim_id=v.id ORDER BY a.created_at DESC")
    rows = c.fetchall()
    conn.close()
    return jsonify([row_to_dict(r) for r in rows])

@app.route('/api/recovery/aid-claims', methods=['POST'])
def recovery_create_aid_claim():
    if not session.get('recovery_admin') and not session.get('admin') and not session.get('recovery_user_id'):
        return jsonify({"error": "Unauthorized"}), 401
    data = request.json
    if not data.get('claimant_name'):
        return jsonify({"error": "Claimant name required"}), 400
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("INSERT INTO aid_claims (user_id,victim_id,claimant_name,category,amount,description) VALUES (?,?,?,?,?,?)",
        (session.get('recovery_user_id'), data.get('victim_id'), data['claimant_name'],
         data.get('category'), data.get('amount', 0), data.get('description')))
    cid = c.lastrowid
    conn.commit()
    conn.close()
    recovery_log("AID_CLAIM", f"Claim #{cid} by {data['claimant_name']} ₹{data.get('amount', 0)}")
    return jsonify({"success": True, "id": cid})

@app.route('/api/recovery/aid-claims/<int:cid>/action', methods=['PUT'])
def recovery_action_aid_claim(cid):
    if not session.get('recovery_admin') and not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    data = request.json
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("UPDATE aid_claims SET status=?,approved_by=? WHERE id=?",
              (data['status'], data.get('actor', 'admin'), cid))
    conn.commit()
    conn.close()
    recovery_log("CLAIM_ACTION", f"Claim #{cid} {data['status']}")
    return jsonify({"success": True})

@app.route('/api/recovery/aid-claims/<int:cid>', methods=['DELETE'])
def recovery_delete_aid_claim(cid):
    if not session.get('recovery_admin') and not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("DELETE FROM aid_claims WHERE id=?", (cid,))
    conn.commit()
    conn.close()
    recovery_log("CLAIM_DELETE", f"Claim #{cid} deleted by admin")
    return jsonify({"success": True})

# ─── Recovery API — Activity Feed ─────────────────────────────────────────────
@app.route('/api/recovery/activity')
def recovery_get_activity():
    if not session.get('recovery_admin') and not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 30")
    rows = c.fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

# ─── Recovery API — Auto-Allocate ─────────────────────────────────────────────
@app.route('/api/recovery/auto-allocate', methods=['POST'])
def recovery_auto_allocate():
    if not session.get('recovery_admin') and not session.get('admin'):
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("SELECT * FROM victims WHERE shelter_id IS NULL AND status!='rescued'")
    unassigned = c.fetchall()
    c.execute("SELECT * FROM shelters WHERE status='active' AND current_occupancy<total_capacity ORDER BY current_occupancy ASC")
    available = list(c.fetchall())
    count = 0
    for v in unassigned:
        if not available:
            break
        sh = available[0]
        c.execute("UPDATE victims SET shelter_id=?,status='sheltered',updated_at=? WHERE id=?", (sh['id'], datetime.now(), v['id']))
        c.execute("UPDATE shelters SET current_occupancy=current_occupancy+1 WHERE id=?", (sh['id'],))
        if sh['current_occupancy'] + 1 >= sh['total_capacity']:
            available = available[1:]
        count += 1
    conn.commit()
    conn.close()
    recovery_log("AUTO_ALLOCATE", f"Auto-allocated {count} victims")
    return jsonify({"success": True, "assigned": count})

# ─── Recovery API — User-facing (citizen portal) ──────────────────────────────
@app.route('/api/user/nearby-shelters')
def recovery_nearby_shelters():
    if not session.get('user_id') and not session.get('recovery_user_id') \
       and not session.get('admin') and not session.get('recovery_admin'):
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("SELECT * FROM shelters WHERE status != 'closed' ORDER BY status DESC, name")
    rows = c.fetchall()
    conn.close()
    shelters = [dict(r) for r in rows]
    try:
        lat = float(request.args.get('lat', 0))
        lng = float(request.args.get('lng', 0))
        if lat and lng:
            def haversine(la1, lo1, la2, lo2):
                R = 6371
                dl = math.radians(la2 - la1)
                dL = math.radians(lo2 - lo1)
                a  = math.sin(dl/2)**2 + math.cos(math.radians(la1)) * math.cos(math.radians(la2)) * math.sin(dL/2)**2
                return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
            for s in shelters:
                if s.get('latitude') and s.get('longitude'):
                    s['distance_km'] = round(haversine(lat, lng, s['latitude'], s['longitude']), 2)
                else:
                    s['distance_km'] = None
            shelters.sort(key=lambda x: (x['distance_km'] is None, x['distance_km'] or 9999))
    except:
        pass
    return jsonify(shelters)

@app.route('/api/user/recovery-sos', methods=['POST'])
def recovery_user_sos():
    if not session.get('recovery_user_id'):
        return jsonify({"error": "Unauthorized"}), 401
    data     = request.json
    priority = data.get('priority', 'NORMAL')
    pcolor   = {'HIGH': 'red', 'MEDIUM': 'orange', 'NORMAL': 'green'}.get(priority, 'green')
    user_id  = session.get('recovery_user_id')
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("SELECT id FROM victims WHERE user_id=? LIMIT 1", (user_id,))
    existing = c.fetchone()
    if existing:
        vid = existing['id']
        c.execute("UPDATE victims SET phone=?,medical_condition=?,priority=?,priority_color=?,latitude=?,longitude=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
                  (data.get('phone'), data.get('medical_condition'), priority, pcolor, data.get('latitude'), data.get('longitude'), vid))
    else:
        c.execute("INSERT INTO victims (user_id,name,phone,medical_condition,vulnerability_tags,priority,priority_color,status,latitude,longitude,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                  (user_id, data.get('name', 'Unknown'), data.get('phone'), data.get('medical_condition'),
                   '', priority, pcolor, 'missing', data.get('latitude'), data.get('longitude'), 'SOS submitted via citizen portal'))
        vid = c.lastrowid
    conn.commit()
    conn.close()
    recovery_log("USER_SOS", f"SOS for user #{user_id} (victim #{vid})")
    return jsonify({"success": True, "id": vid})

@app.route('/api/user/assign-shelter', methods=['POST'])
def user_assign_shelter():
    """Victim self-assigns to a shelter — no admin auth required."""
    user_id = session.get('recovery_user_id') or session.get('user_id')
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    data = request.json or {}
    sid  = data.get('shelter_id')
    if not sid:
        return jsonify({"error": "shelter_id required"}), 400
    conn = get_recovery_db()
    c    = conn.cursor()
    # Find the victim record linked to this user
    c.execute("SELECT id, shelter_id FROM victims WHERE user_id=? LIMIT 1", (user_id,))
    row = c.fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "No victim record found. Please submit SOS first."}), 404
    vid = row['id']
    old_sid = row['shelter_id']
    # Decrement old shelter occupancy if changing shelter
    if old_sid and old_sid != sid:
        c.execute("UPDATE shelters SET current_occupancy=MAX(0,current_occupancy-1) WHERE id=?", (old_sid,))
    # Assign victim to new shelter
    c.execute("UPDATE victims SET shelter_id=?,status='sheltered',updated_at=CURRENT_TIMESTAMP WHERE id=?", (sid, vid))
    if not old_sid or old_sid != sid:
        c.execute("UPDATE shelters SET current_occupancy=current_occupancy+1 WHERE id=?", (sid,))
    conn.commit()
    conn.close()
    recovery_log("VICTIM_ASSIGNED", f"Victim #{vid} self-assigned to shelter #{sid}")
    return jsonify({"success": True, "victim_id": vid})

@app.route('/api/user/smart-assign-shelter', methods=['POST'])
def user_smart_assign_shelter():
    """
    Smart shelter assignment based on the PPT algorithm:
    Cost = (distance_km × 0.5) + (occupancy_pct × 0.3) + (risk_penalty × 0.2)
    
    - distance_km   : Haversine distance victim → shelter
    - occupancy_pct : current_occupancy / total_capacity (0–1)
    - risk_penalty  : 0=SAFE, 0.3=WATCH, 0.6=HIGH RISK, 1.0=CRITICAL
                      Uses current system prediction to penalise shelters
                      in high-risk areas (shelters with higher occupancy under
                      disaster pressure get penalised more)
    Picks the shelter with the LOWEST cost score that still has capacity.
    """
    user_id = session.get('recovery_user_id') or session.get('user_id')
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    data = request.json or {}
    user_lat = data.get('latitude')
    user_lng = data.get('longitude')

    conn = get_recovery_db()
    c    = conn.cursor()

    # Must have a victim record
    c.execute("SELECT id, shelter_id FROM victims WHERE user_id=? LIMIT 1", (user_id,))
    row = c.fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "No victim record found. Please submit SOS first."}), 404
    vid     = row['id']
    old_sid = row['shelter_id']

    # If already assigned, return current assignment info
    if old_sid:
        c.execute("SELECT * FROM shelters WHERE id=?", (old_sid,))
        existing = c.fetchone()
        conn.close()
        if existing:
            ex = dict(existing)
            return jsonify({
                "success": True,
                "already_assigned": True,
                "shelter": ex,
                "message": f"You are already assigned to {ex['name']}"
            })

    # Get all active shelters with capacity
    c.execute("SELECT * FROM shelters WHERE status='active' AND current_occupancy < total_capacity")
    shelters = [dict(r) for r in c.fetchall()]
    conn.close()

    if not shelters:
        return jsonify({"error": "No shelters with available capacity right now."}), 404

    # Get current system risk level for penalty weight
    risk_level = get_current_risk_level()
    risk_penalty_map = {"SAFE": 0.0, "WATCH": 0.3, "HIGH RISK": 0.6, "CRITICAL": 1.0}
    base_risk_penalty = risk_penalty_map.get(risk_level, 0.3)

    def haversine(la1, lo1, la2, lo2):
        R = 6371
        dl = math.radians(la2 - la1)
        dL = math.radians(lo2 - lo1)
        a  = math.sin(dl/2)**2 + math.cos(math.radians(la1)) * math.cos(math.radians(la2)) * math.sin(dL/2)**2
        return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    # Score each shelter
    scored = []
    for s in shelters:
        if not s.get('latitude') or not s.get('longitude'):
            continue
        dist_km     = haversine(user_lat, user_lng, s['latitude'], s['longitude']) if (user_lat and user_lng) else 5.0
        occ_pct     = s['current_occupancy'] / max(s['total_capacity'], 1)
        # Under high risk, shelters that are already crowded are penalised harder
        risk_pen    = base_risk_penalty * occ_pct
        cost        = (dist_km * 0.5) + (occ_pct * 0.3) + (risk_pen * 0.2)
        s['distance_km']  = round(dist_km, 2)
        s['cost_score']   = round(cost, 4)
        s['risk_level']   = risk_level
        scored.append(s)

    if not scored:
        return jsonify({"error": "No shelters with valid location data found."}), 404

    # Sort by cost ascending — lowest cost = best shelter
    scored.sort(key=lambda x: x['cost_score'])
    best = scored[0]

    # Assign victim
    conn2 = get_recovery_db()
    c2    = conn2.cursor()
    c2.execute("UPDATE victims SET shelter_id=?,status='sheltered',updated_at=CURRENT_TIMESTAMP WHERE id=?",
               (best['id'], vid))
    c2.execute("UPDATE shelters SET current_occupancy=current_occupancy+1 WHERE id=?", (best['id'],))
    conn2.commit()
    conn2.close()

    free = best['total_capacity'] - best['current_occupancy']
    recovery_log("SMART_ASSIGN", f"Victim #{vid} smart-assigned to shelter #{best['id']} ({best['name']}) cost={best['cost_score']}")
    return jsonify({
        "success": True,
        "already_assigned": False,
        "shelter": best,
        "score_breakdown": {
            "distance_km":   best['distance_km'],
            "occupancy_pct": round(best['current_occupancy'] / max(best['total_capacity'], 1), 2),
            "risk_level":    risk_level,
            "cost_score":    best['cost_score']
        },
        "message": f"Assigned to {best['name']} — {best['distance_km']} km away, {free} beds free"
    })

@app.route('/api/user/my-recovery-status')
def recovery_user_status():
    if not session.get('recovery_user_id'):
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("SELECT v.*, s.name as shelter_name FROM victims v LEFT JOIN shelters s ON v.shelter_id=s.id WHERE v.user_id=? ORDER BY v.created_at DESC LIMIT 1", (session.get('recovery_user_id'),))
    victim = c.fetchone()
    conn.close()
    return jsonify(dict(victim) if victim else None)

@app.route('/api/user/my-recovery-claims')
def recovery_user_claims():
    if not session.get('recovery_user_id'):
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("SELECT * FROM aid_claims WHERE user_id=? ORDER BY created_at DESC", (session.get('recovery_user_id'),))
    rows = c.fetchall()
    conn.close()
    return jsonify([row_to_dict(r) for r in rows])

@app.route('/api/user/my-recovery-reports')
def recovery_user_reports():
    if not session.get('recovery_user_id'):
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("SELECT * FROM damage_reports WHERE user_id=? ORDER BY created_at DESC", (session.get('recovery_user_id'),))
    rows = c.fetchall()
    conn.close()
    return jsonify([row_to_dict(r) for r in rows])

@app.route('/api/user/recovery-aid-claims', methods=['POST'])
def recovery_user_aid_claim():
    if not session.get('recovery_user_id'):
        return jsonify({"error": "Unauthorized"}), 401
    data     = request.json
    user_id  = session.get('recovery_user_id')
    username = session.get('recovery_user_name')
    if not data.get('category') or not data.get('amount'):
        return jsonify({"error": "Category and amount required"}), 400
    conn = get_recovery_db()
    c    = conn.cursor()
    c.execute("SELECT id FROM victims WHERE user_id=? LIMIT 1", (user_id,))
    victim    = c.fetchone()
    victim_id = victim['id'] if victim else None
    c.execute("INSERT INTO aid_claims (user_id,victim_id,claimant_name,category,amount,description) VALUES (?,?,?,?,?,?)",
              (user_id, victim_id, username, data.get('category'), data.get('amount'), data.get('description')))
    cid = c.lastrowid
    conn.commit()
    conn.close()
    recovery_log("USER_AID_CLAIM", f"Claim #{cid} by user #{user_id} ₹{data.get('amount')}")
    return jsonify({"success": True, "id": cid})

# ─── RUN ──────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    # ── Startup diagnostics ───────────────────────────────────
    print("\n" + "="*55)
    missing = []
    for label, path in [
        ("Templates",          TEMPLATE_DIR),
        ("Static",             STATIC_DIR),
        ("Database",           os.path.dirname(DATABASE)),
        ("Model",              os.path.dirname(MODEL_PATH)),
        ("Data",               os.path.dirname(DATA_PATH)),
        ("Recovery Module",    RECOVERY_DIR),
        ("Recovery Templates", RECOVERY_TEMPLATE),
    ]:
        exists = "✅" if os.path.exists(path) else "❌ MISSING"
        if not os.path.exists(path): missing.append(label)
        print(f"  {exists}  {label}: {path}")
    if missing:
        print(f"\n  ⚠️  Missing folders: {missing}")
    print("="*55)
    print("\n" + "="*55)
    print("🛡️  GeoSecure Chennai — Integrated Server (All 3 Modules)")
    print("="*55)
    print("  Hub                 → http://localhost:5000")
    print("  Pre-Disaster        → http://localhost:5000/pre-disaster")
    print("  Victim SOS          → http://localhost:5000/victim")
    print("  Rescue Control Room → http://localhost:5000/admin/dashboard")
    print("  Recovery Portal     → http://localhost:5000/recovery/user")
    print("  Recovery Admin      → http://localhost:5000/recovery/dashboard")
    print("  ─────────────────────────────────────────────────────")
    print("  Rescue Admin login  → secure_control@gmail.com / secure_control")
    print("  Recovery Admin      → recovery_admin@geosecure.com / recovery_control")
    print("="*55 + "\n")
    app.run(debug=True, host='127.0.0.1', port=5000)