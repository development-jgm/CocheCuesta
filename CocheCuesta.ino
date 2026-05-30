const int N = 8;
int buf_brake[N], buf_clutch[N], buf_accel[N];
int idx        = 0;
long sum_brake = 0, sum_clutch = 0, sum_accel = 0;

void setup() {
  Serial.begin(9600);
  for (int i = 0; i < N; i++) {
    buf_brake[i]  = analogRead(A0);
    buf_clutch[i] = analogRead(A1);
    buf_accel[i]  = analogRead(A2);
    sum_brake  += buf_brake[i];
    sum_clutch += buf_clutch[i];
    sum_accel  += buf_accel[i];
  }
}

void loop() {
  sum_brake  -= buf_brake[idx];
  buf_brake[idx]  = analogRead(A0);
  sum_brake  += buf_brake[idx];

  sum_clutch -= buf_clutch[idx];
  buf_clutch[idx] = analogRead(A1);
  sum_clutch += buf_clutch[idx];

  sum_accel  -= buf_accel[idx];
  buf_accel[idx]  = analogRead(A2);
  sum_accel  += buf_accel[idx];

  idx = (idx + 1) % N;

  // Mapea el rango físico disponible (100-600) a 0-100
  int brake  = constrain(map(sum_brake  / N, 100, 600, 0, 100), 0, 100);
  int clutch = constrain(map(sum_clutch / N, 100, 600, 0, 100), 0, 100);
  int accel  = constrain(map(sum_accel  / N, 100, 600, 0, 100), 0, 100);

  Serial.print(brake);
  Serial.print(",");
  Serial.print(clutch);
  Serial.print(",");
  Serial.println(accel);
  delay(50);
}
