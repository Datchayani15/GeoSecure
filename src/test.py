import xarray as xr

try:
    ds = xr.open_dataset('data/raw/weather_2021.nc', engine='netcdf4')
    print("✅ FILE IS VALID!")
    print(f"Variables found: {list(ds.data_vars)}")
    print(f"Time steps: {len(ds.time)}")
    # Check if precipitation has actual values
    max_rain = float(ds.tp.max())
    print(f"Max rainfall in data: {max_rain} meters")
    ds.close()
except Exception as e:
    print(f"❌ DATA IS EMPTY OR CORRUPT: {e}")