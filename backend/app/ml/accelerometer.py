"""
Accelerometer FFT preprocessing for Fleet AI.

Raw 3-axis accelerometer data (g-force time series) is converted to
frequency-domain features before entering the ML pipeline. This is required
because bearing wear, driveshaft imbalance, and engine mount degradation
produce specific frequency signatures — not amplitude spikes.

Supported input formats:
  - Geotab GO9 native (3-axis at ~10-100Hz via IOX)
  - J1939 PGN 61485 (OEM native accelerometer on Class 8 trucks)
  - External module (CSS Electronics, Noregon) at configurable sample rate

Output features (all optional — None if insufficient data):
  accel_x_rms, accel_y_rms, accel_z_rms     — per-axis RMS amplitude
  accel_peak_x, accel_peak_y, accel_peak_z   — peak-to-peak per axis
  bearing_freq_score                          — energy in bearing failure bands
  drivetrain_freq_score                       — energy at driveshaft harmonics
  engine_mount_score                          — low-frequency idle vibration score
  vibration_asymmetry                         — Z vs XY ratio (detects imbalance)
"""
from __future__ import annotations

import math
from typing import Optional


# Bearing failure frequency bands (normalized — multiply by RPM/60 for Hz)
# Inner race: ~0.6 × shaft_freq × n_balls
# Outer race: ~0.4 × shaft_freq × n_balls
# Typical commercial truck wheel bearing: 14-16 balls
_BEARING_RATIO_LOW  = 0.35   # outer race lower bound
_BEARING_RATIO_HIGH = 0.65   # inner race upper bound

# Driveshaft harmonic ratios relative to wheel rotation frequency
_DRIVESHAFT_HARMONICS = [1.0, 2.0, 3.0, 4.0]

# Engine idle frequency bands (Hz) — engine mount degradation shows here
_IDLE_BAND_HZ_LOW  = 5.0
_IDLE_BAND_HZ_HIGH = 30.0


def _fft_magnitudes(signal: list[float]) -> list[float]:
    """
    Pure-Python DFT for short signals (n ≤ 2048).
    Returns magnitude spectrum (first n//2 bins).
    """
    n = len(signal)
    if n < 4:
        return []
    # Remove DC component
    mean = sum(signal) / n
    x = [v - mean for v in signal]

    # Pad or truncate to nearest power of 2 (naive DFT is fast enough at this
    # size — no Cooley-Tukey butterfly needed, and no bit-reversal permutation
    # either, since that only pays off once the butterfly stage is implemented;
    # permuting sample order here without it would corrupt every non-DC bin).
    size = 1
    while size < n:
        size <<= 1
    size = min(size, 2048)
    x = (x + [0.0] * size)[:size]

    magnitudes = []
    for k in range(size // 2):
        re = sum(x[t] * math.cos(2 * math.pi * k * t / size) for t in range(size))
        im = sum(-x[t] * math.sin(2 * math.pi * k * t / size) for t in range(size))
        magnitudes.append(math.sqrt(re * re + im * im) / size)
    return magnitudes


def _rms(values: list[float]) -> Optional[float]:
    if not values:
        return None
    return round(math.sqrt(sum(v * v for v in values) / len(values)), 6)


def _peak_to_peak(values: list[float]) -> Optional[float]:
    if not values:
        return None
    return round(max(values) - min(values), 6)


def _band_energy(magnitudes: list[float], bin_low: int, bin_high: int) -> float:
    """Sum of FFT magnitude in a frequency band."""
    band = magnitudes[max(0, bin_low):min(len(magnitudes), bin_high + 1)]
    return sum(band)


def _spectral_kurtosis(magnitudes: list[float], bin_low: int, bin_high: int) -> Optional[float]:
    """
    Compute spectral kurtosis of FFT magnitudes within a frequency band.

    Spectral kurtosis is the 4th standardized moment of the magnitude distribution.
    Values:
      < 3.0  — Gaussian / stationary (healthy bearing)
      3–6    — Elevated impulsivity (early wear)
      > 6.0  — Highly impulsive (Phase 1 spall damage — weeks of warning)
      > 10.0 — Severe damage (Phase 2/3 spall)

    Returns None if insufficient data.
    """
    band = magnitudes[max(0, bin_low):min(len(magnitudes), bin_high + 1)]
    n = len(band)
    if n < 4:
        return None
    mean = sum(band) / n
    variance = sum((v - mean) ** 2 for v in band) / n
    if variance < 1e-18:
        return None
    std = variance ** 0.5
    fourth_moment = sum((v - mean) ** 4 for v in band) / n
    return round(fourth_moment / (variance ** 2), 4)


def extract_accel_features(
    accel_x: list[float],
    accel_y: list[float],
    accel_z: list[float],
    sample_rate_hz: float = 25.0,
    vehicle_speed_kph: Optional[float] = None,
    rpm: Optional[float] = None,
) -> dict[str, Optional[float]]:
    """
    Convert raw accelerometer time-series to scalar features for the ML pipeline.

    Args:
        accel_x, accel_y, accel_z: Time-series of g-force readings per axis.
        sample_rate_hz: Sampling rate in Hz (Geotab GO9 default: 25Hz).
        vehicle_speed_kph: Current vehicle speed — used to compute bearing frequency.
        rpm: Current engine RPM — used to identify engine-frequency harmonics.

    Returns:
        Dict of feature_name -> float (or None if insufficient data).
    """
    feats: dict[str, Optional[float]] = {
        "accel_x_rms": None,
        "accel_y_rms": None,
        "accel_z_rms": None,
        "accel_peak_x": None,
        "accel_peak_y": None,
        "accel_peak_z": None,
        "bearing_freq_score": None,
        "drivetrain_freq_score": None,
        "engine_mount_score": None,
        "vibration_asymmetry": None,
        # Phase 2A — spectral kurtosis per band
        "bearing_spectral_kurtosis": None,    # >6 = Stage 1 spall (weeks of warning)
        "drivetrain_spectral_kurtosis": None,  # >6 = driveshaft fault
        "engine_spectral_kurtosis": None,      # >6 = engine mount failure
    }

    if not accel_x or not accel_y or not accel_z:
        return feats

    # RMS and peak-to-peak per axis
    feats["accel_x_rms"]  = _rms(accel_x)
    feats["accel_y_rms"]  = _rms(accel_y)
    feats["accel_z_rms"]  = _rms(accel_z)
    feats["accel_peak_x"] = _peak_to_peak(accel_x)
    feats["accel_peak_y"] = _peak_to_peak(accel_y)
    feats["accel_peak_z"] = _peak_to_peak(accel_z)

    # Z-axis asymmetry vs XY (vertical vs lateral — detects imbalance)
    z_rms  = feats["accel_z_rms"] or 0.0
    xy_rms = ((feats["accel_x_rms"] or 0.0) + (feats["accel_y_rms"] or 0.0)) / 2.0
    if xy_rms > 1e-6:
        feats["vibration_asymmetry"] = round(z_rms / xy_rms, 4)

    # FFT — use Z axis (vertical, most sensitive to road/bearing excitation)
    n = min(len(accel_z), 512)
    if n >= 16:
        mags = _fft_magnitudes(accel_z[:n])
        if mags:
            freq_resolution = sample_rate_hz / (len(mags) * 2)

            # Bearing frequency band (speed-dependent)
            if vehicle_speed_kph and vehicle_speed_kph > 5:
                # Wheel rotation freq (typical truck tire: ~1m radius → ~0.32m circumference)
                tire_circumference_m = 3.2  # Class 8 truck typical
                wheel_freq_hz = (vehicle_speed_kph / 3.6) / tire_circumference_m
                bear_low_hz  = wheel_freq_hz * _BEARING_RATIO_LOW  * 14
                bear_high_hz = wheel_freq_hz * _BEARING_RATIO_HIGH * 16
                bin_low  = max(0, int(bear_low_hz  / freq_resolution))
                bin_high = min(len(mags) - 1, int(bear_high_hz / freq_resolution))
                if bin_high > bin_low:
                    total_energy = sum(mags) or 1e-9
                    feats["bearing_freq_score"] = round(
                        min(1.0, _band_energy(mags, bin_low, bin_high) / total_energy * 10), 4
                    )
                    # Phase 2A: spectral kurtosis in bearing band
                    sk = _spectral_kurtosis(mags, bin_low, bin_high)
                    if sk is not None:
                        feats["bearing_spectral_kurtosis"] = sk

            # Driveshaft harmonics (speed-dependent)
            if vehicle_speed_kph and vehicle_speed_kph > 5:
                drive_shaft_freq = (vehicle_speed_kph / 3.6) / 3.2 * 3.5  # ~3.5 axle ratio
                harmonic_energy = 0.0
                ds_bin_low, ds_bin_high = len(mags), 0
                for h in _DRIVESHAFT_HARMONICS:
                    freq_hz = drive_shaft_freq * h
                    b = int(freq_hz / freq_resolution)
                    if 0 <= b < len(mags):
                        harmonic_energy += mags[b]
                        ds_bin_low  = min(ds_bin_low,  max(0, b - 2))
                        ds_bin_high = max(ds_bin_high, min(len(mags) - 1, b + 2))
                total_energy = sum(mags) or 1e-9
                feats["drivetrain_freq_score"] = round(
                    min(1.0, harmonic_energy / total_energy * 8), 4
                )
                if ds_bin_high > ds_bin_low:
                    sk = _spectral_kurtosis(mags, ds_bin_low, ds_bin_high)
                    if sk is not None:
                        feats["drivetrain_spectral_kurtosis"] = sk

            # Engine mount score — low-frequency energy when RPM < 1000 (idle)
            if rpm and rpm < 1000:
                low_bin  = int(_IDLE_BAND_HZ_LOW  / freq_resolution)
                high_bin = int(_IDLE_BAND_HZ_HIGH / freq_resolution)
                if high_bin > low_bin:
                    total_energy = sum(mags) or 1e-9
                    idle_energy = _band_energy(mags, low_bin, high_bin)
                    feats["engine_mount_score"] = round(
                        min(1.0, idle_energy / total_energy * 5), 4
                    )
                    sk = _spectral_kurtosis(mags, low_bin, high_bin)
                    if sk is not None:
                        feats["engine_spectral_kurtosis"] = sk

    return feats


def accel_from_samples(
    samples: list[dict],
    sample_rate_hz: float = 25.0,
    vehicle_speed_kph: Optional[float] = None,
    rpm: Optional[float] = None,
) -> dict[str, Optional[float]]:
    """
    Extract accelerometer features from a list of telemetry samples.
    Samples may have metrics.accelX / accelY / accelZ (scalar per sample)
    or a single metrics.accelBurst (list payload from a burst transmission).
    """
    x_vals, y_vals, z_vals = [], [], []

    for s in samples:
        m = s.get("metrics", {})
        # Burst format — one sample contains a list of readings
        if isinstance(m.get("accelBurstX"), list):
            x_vals.extend(float(v) for v in m["accelBurstX"] if v is not None)
            y_vals.extend(float(v) for v in m.get("accelBurstY", []) if v is not None)
            z_vals.extend(float(v) for v in m.get("accelBurstZ", []) if v is not None)
        else:
            # Scalar per sample
            ax = m.get("accelX") or m.get("accel_x")
            ay = m.get("accelY") or m.get("accel_y")
            az = m.get("accelZ") or m.get("accel_z")
            if ax is not None: x_vals.append(float(ax))
            if ay is not None: y_vals.append(float(ay))
            if az is not None: z_vals.append(float(az))

    if not x_vals and not z_vals:
        return {k: None for k in [
            "accel_x_rms", "accel_y_rms", "accel_z_rms",
            "accel_peak_x", "accel_peak_y", "accel_peak_z",
            "bearing_freq_score", "drivetrain_freq_score",
            "engine_mount_score", "vibration_asymmetry",
        ]}

    return extract_accel_features(
        x_vals, y_vals, z_vals,
        sample_rate_hz=sample_rate_hz,
        vehicle_speed_kph=vehicle_speed_kph,
        rpm=rpm,
    )
