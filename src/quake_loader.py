import requests
import pandas as pd
import os

def fetch_quake_data():
    print("Connecting to USGS Seismic Database for Chennai region...")
    url = "https://earthquake.usgs.gov/fdsnws/event/1/query"
    
    # Matching your weather data window exactly
    params = {
        "format": "csv",
        "starttime": "2014-01-01",
        "endtime": "2024-12-31",
        "latitude": 13.08,    # Chennai
        "longitude": 80.27,
        "maxradiuskm": 500,   # 500km radius
        "minmagnitude": 2.0,  # Focus on detectable tremors
        "orderby": "time-asc"
    }

    response = requests.get(url, params=params)
    
    if response.status_code == 200:
        os.makedirs('data/raw', exist_ok=True)
        file_path = 'data/raw/earthquake_data.csv'
        with open(file_path, 'w') as f:
            f.write(response.text)
        print(f"✅ Success! Earthquake history saved to {file_path}")
    else:
        print(f"❌ Error: Could not fetch data (Status: {response.status_code})")

if __name__ == "__main__":
    fetch_quake_data()