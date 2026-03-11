import pandas as pd
import numpy as np
from sklearn.preprocessing import MinMaxScaler
import joblib
import os

def process_combined_data():
    print("🧠 Merging Weather & Earthquake Data...")
    
    # Load Weather
    df_weather = pd.read_csv("data/raw/chennai_weather_final.csv")
    df_weather['timestamp'] = pd.to_datetime(df_weather['timestamp'])

    # Earthquake File
    earthquake_path = "data/raw/earthquake_data.csv"
    
    if os.path.exists(earthquake_path):
        df_geo = pd.read_csv(earthquake_path)
        
        # --- AUTO-DETECT TIME COLUMN ---
        # Look for common column names for time
        possible_time_cols = ['timestamp', 'time', 'Date', 'datetime', 'DateTime']
        time_col = next((c for c in possible_time_cols if c in df_geo.columns), None)
        
        if time_col:
            df_geo['timestamp'] = pd.to_datetime(df_geo[time_col])
            print(f"✅ Found time column: '{time_col}'")
        else:
            print(f"❌ Error: Could not find a time column in {earthquake_path}")
            print(f"Available columns are: {list(df_geo.columns)}")
            return

        # --- AUTO-DETECT MAGNITUDE COLUMN ---
        mag_col = next((c for c in ['magnitude', 'mag', 'Mag'] if c in df_geo.columns), 'magnitude')
        if mag_col in df_geo.columns:
            df_geo['magnitude'] = df_geo[mag_col]
        else:
            print(f"⚠️ 'magnitude' column not found, using 0s.")
            df_geo['magnitude'] = 0

        # Merge weather and geo data
        df = pd.merge_asof(df_weather.sort_values('timestamp'), 
                          df_geo.sort_values('timestamp'), 
                          on='timestamp', direction='backward')
        
        df['magnitude'] = df['magnitude'].fillna(0)
        print("✅ Earthquake data successfully merged!")
    else:
        print(f"❌ Error: {earthquake_path} not found!")
        return

    # 1. Feature Selection
    features = ['temperature', 'precipitation', 'pressure', 'cloud_cover', 'magnitude']
    data = df[features].values

    # 2. Normalization
    scaler = MinMaxScaler()
    scaled_data = scaler.fit_transform(data)
    os.makedirs('models', exist_ok=True)
    joblib.dump(scaler, 'models/scaler.pkl')
    
    # 3. Create Sequences
    window_size = 24
    X, y_weather, y_geo = [], [], []
    
    for i in range(len(scaled_data) - window_size):
        X.append(scaled_data[i:i+window_size])
        y_weather.append(scaled_data[i+window_size, 1]) # Rain
        y_geo.append(scaled_data[i+window_size, 4])     # Magnitude
        
    X = np.array(X)
    y_weather = np.array(y_weather)
    y_geo = np.array(y_geo)

    # 4. Reshape for ConvLSTM (Samples, Time, Height, Width, Channels)
    X = X.reshape((X.shape[0], window_size, 1, 1, 5))

    os.makedirs('data/processed', exist_ok=True)
    np.save('data/processed/X_train.npy', X)
    np.save('data/processed/y_weather.npy', y_weather)
    np.save('data/processed/y_geo.npy', y_geo)
    
    print(f"✅ FINAL Multi-Hazard dataset ready: {X.shape}")

if __name__ == "__main__":
    process_combined_data()