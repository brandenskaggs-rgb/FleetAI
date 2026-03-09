# Fleet AI Assumptions (Simulation + Savings)

This project now uses a heavier-duty synthetic simulation with weather and elevation stress.

## External Reference Inputs

- Typical heavy-duty truck fuel economy range:
  - EPA SmartWay: approximately 5.9 to 7.2 mpg for Class 8 tractor-trailer combinations.
  - Source: https://www.epa.gov/smartway/smartway-verified-list

- Idle fuel burn estimate:
  - U.S. DOE Alternative Fuels Data Center references around 0.8 gallons per hour for heavy-duty trucks.
  - Source (PDF): https://afdc.energy.gov/files/u/publication/idle_reduction_technologies_trucks.pdf

- Temperature effect on efficiency and operations:
  - FuelEconomy.gov reports significant cold-weather fuel economy reductions.
  - Source: https://fueleconomy.gov/feg/coldweather.shtml

- Elevation/air-density derate consideration:
  - Cummins guidance notes output derate effects above sea level.
  - Source: https://www.cummins.com/generators/powercommand-cloud-and-generator-set-controls/altitude-derate

## Business Baseline Inputs

- Fleet size: 12 trucks
- Annual preventive maintenance baseline: $78,000
  - Provided by user and treated as business input for ROI scenarios.

## Important Constraint

These numbers support planning simulations. They do **not** prove production savings by themselves.
Production proof requires historical maintenance events, true failure labels, and real downtime/accounting records.
