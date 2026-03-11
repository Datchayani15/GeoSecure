import openmeteo_requests
import requests_cache
import pandas as pd
from retry_requests import retry
import os

def fetch_weather_data():
    # 1. Setup the API client with caching (prevents getting blocked)
    cache_session = requests_cache.CachedSession('.cache', expire_after=-1)
    retry_session = retry(cache_session, retries=5, backoff_factor=0.2)
    openmeteo = openmeteo_requests.Client(session=retry_session)

    print("🚀 Ingesting High-Accuracy Weather Data for Chennai (2015-2025)...")
    
    # 2. Define Parameters (Added Cloud Cover for better Sunny Day detection)
    url = "https://archive-api.open-meteo.com/v1/archive"
    params = {
        "latitude": 13.0827,
        "longitude": 80.2707,
        "start_date": "2015-01-01",
        "end_date": "2025-12-31",
        "hourly": ["temperature_2m", "precipitation", "surface_pressure", "cloud_cover"],
        "timezone": "Asia/Kolkata"
    }
    
    # 3. Fetch and Process
    responses = openmeteo.weather_api(url, params=params)
    response = responses[0]

    hourly = response.Hourly()
    data = {
        "timestamp": pd.date_range(
            start=pd.to_datetime(hourly.Time(), unit="s", utc=True),
            end=pd.to_datetime(hourly.TimeEnd(), unit="s", utc=True),
            freq=pd.Timedelta(seconds=hourly.Interval()),
            inclusive="left"
        ),
        "temperature": hourly.Variables(0).ValuesAsNumpy(),
        "precipitation": hourly.Variables(1).ValuesAsNumpy(),
        "pressure": hourly.Variables(2).ValuesAsNumpy(),
        "cloud_cover": hourly.Variables(3).ValuesAsNumpy()
    }

    # 4. Save to CSV
    df = pd.DataFrame(data)
    os.makedirs('data/raw', exist_ok=True)
    output_path = "data/raw/chennai_weather_final.csv"
    df.to_csv(output_path, index=False)
    
    print(f"✅ SUCCESS! {len(df)} hourly records saved to {output_path}")

if __name__ == "__main__":
    fetch_weather_data()